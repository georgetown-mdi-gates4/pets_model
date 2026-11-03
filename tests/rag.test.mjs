import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWithRag } from '../server/rag.mjs';
import { conversationalReply } from '../public/conversation.mjs';

test('greetings use Gemini as conversation without PET citations', async () => {
  assert.match(conversationalReply('hello!'), /^Hi!/);
  assert.equal(conversationalReply('What is differential privacy?'), null);
  let calls = 0;
  const response = await answerWithRag({ message: 'hello!', intent: 'learn' }, {
    apiKey: 'test-key', fetchImpl: async () => { calls++; return modelReply([{ text: 'Hi! What would you like to explore?', source_ids: [] }]); }
  });
  assert.equal(response.status, 'chat');
  assert.equal(calls, 1);
  assert.match(response.segments[0].text, /^Hi!/);
});

function modelReply(segments) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ segments }) }] } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function recordingModel(makeSegments) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const ids = body.generationConfig.responseSchema.properties.segments.items.properties.source_ids.items.enum || [];
    return modelReply(makeSegments(ids, body));
  };
  return { calls, fetchImpl };
}

test('grounded informational answer exposes only cited public-source metadata', async () => {
  const model = recordingModel(ids => [{ text: 'Differential privacy needs a release budget.', source_ids: [ids[0]] }]);
  const response = await answerWithRag({ message: 'What is differential privacy?', intent: 'learn' }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'ok');
  assert.equal(response.segments.length, 1);
  assert.equal(response.sources.length, 1);
  assert.equal(response.sources[0].id, response.segments[0].source_ids[0]);
  assert.match(response.sources[0].url, /^https:\/\//);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].options.headers['x-goog-api-key'], 'test-key');
  assert.equal(model.calls[0].body.store, undefined);
  assert.match(model.calls[0].url, /gemini-3\.5-flash-lite:generateContent$/);
});

test('invented citations cause fail-closed response', async () => {
  const model = recordingModel(() => [{ text: 'An unsupported claim.', source_ids: ['invented-source'] }]);
  const response = await answerWithRag({ message: 'Explain private set intersection', intent: 'learn' }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'unavailable');
  assert.equal(response.reason, 'invalid_citations');
  assert.deepEqual(response.sources, []);
});

test('no matching PET source uses conversational Gemini without citations', async () => {
  let calls = 0;
  const response = await answerWithRag({ message: 'volcanoes astrophysics xylophone', intent: 'learn' }, {
    apiKey: 'test-key', fetchImpl: async () => { calls++; return modelReply([{ text: 'Could you clarify your question?', source_ids: [] }]); }
  });
  assert.equal(response.status, 'chat');
  assert.equal(response.sources.length, 0);
  assert.equal(calls, 1);
});

test('daily model budget is reserved only after evidence and review gates, and fails closed', async () => {
  const model = recordingModel(ids => [{ text: 'A cited answer.', source_ids: [ids[0]] }]);
  let reservations = 0;
  const reserveModelCall = async () => { reservations++; return false; };
  const noEvidence = await answerWithRag({ message: 'volcanoes astrophysics xylophone', intent: 'learn' },
    { apiKey: 'test-key', fetchImpl: model.fetchImpl, reserveModelCall });
  assert.equal(noEvidence.reason, 'daily_limit');
  const review = await answerWithRag({ message: 'Can we share student records under FERPA?', intent: 'learn' },
    { apiKey: 'test-key', fetchImpl: model.fetchImpl, reserveModelCall });
  assert.equal(review.reason, 'human_review_required');
  assert.equal(reservations, 1);
  const limited = await answerWithRag({ message: 'What is differential privacy?', intent: 'learn' },
    { apiKey: 'test-key', fetchImpl: model.fetchImpl, reserveModelCall });
  assert.equal(limited.reason, 'daily_limit');
  assert.equal(reservations, 2);
  assert.equal(model.calls.length, 0);
  const failed = await answerWithRag({ message: 'What is differential privacy?', intent: 'learn' },
    { apiKey: 'test-key', fetchImpl: model.fetchImpl, reserveModelCall: async () => { throw new Error('storage unavailable'); } });
  assert.equal(failed.status, 'unavailable');
  assert.equal(model.calls.length, 0);
});

test('protected case without reviewed authority never reaches the model', async () => {
  const model = recordingModel(() => { throw new Error('Should not call model'); });
  const response = await answerWithRag({
    message: 'We need fuzzy student record linkage across agencies.', intent: 'choose',
    profile: { goal: 'link', holders: 'many', match: 'fuzzy', sensitivity: 'protected', authority: 'unknown' }
  }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'review');
  assert.equal(response.reason, 'human_review_required');
  assert.equal(model.calls.length, 0);
});

test('informational PET explanation about student records can use public evidence', async () => {
  const model = recordingModel(ids => [{ text: 'Approximate record linkage requires measuring false matches.', source_ids: [ids[0]] }]);
  const response = await answerWithRag({
    message: 'Explain fuzzy linkage for student records.', intent: 'learn'
  }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'ok');
  assert.equal(model.calls.length, 1);
});

test('legal permission question routes to review without a model call', async () => {
  let called = false;
  const response = await answerWithRag({
    message: 'Can we share student records under FERPA?', intent: 'learn'
  }, { apiKey: 'test-key', fetchImpl: async () => { called = true; throw new Error('Should not call model'); } });
  assert.equal(response.status, 'review');
  assert.equal(called, false);
});

test('legal permission to link or train records is reviewed even if labeled learn', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('Should not call model'); };
  for (const message of [
    'May we link student records under FERPA?',
    'Would FERPA allow us to train a model on student records?'
  ]) {
    const response = await answerWithRag({ message, intent: 'learn' }, { apiKey: 'test-key', fetchImpl });
    assert.equal(response.status, 'review', message);
    assert.equal(response.reason, 'human_review_required', message);
  }
  assert.equal(called, false);
});

test('case-specific protected-data advice cannot bypass authority review with learn intent', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('Should not call model'); };
  for (const message of [
    'Can we train on protected student records?',
    'Which PET should we use for protected student records?'
  ]) {
    const response = await answerWithRag({ message, intent: 'learn' }, { apiKey: 'test-key', fetchImpl });
    assert.equal(response.status, 'review', message);
    assert.equal(response.reason, 'human_review_required', message);
  }
  assert.equal(called, false);
});

test('approved case advice labeled learn still uses decision rules and curated evidence', async () => {
  const model = recordingModel(ids => [{ text: 'Approximate linkage needs specialist evaluation.', source_ids: [ids[0]] }]);
  const response = await answerWithRag({
    message: 'We need fuzzy student record linkage. Legal review is approved.', intent: 'learn',
    profile: { goal: 'link', holders: 'many', rawMove: 'no', match: 'fuzzy', output: 'aggregate', sensitivity: 'protected', capacity: 'medium', authority: 'yes' }
  }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'ok');
  const prompt = model.calls[0].body.contents[0].parts[0].text;
  assert.match(prompt, /"intent":"choose"/);
  assert.match(prompt, /"decision_rules":\{"status"/);
  assert.match(prompt, /nih-pprl-fuzzy/);
});

test('direct identifier or protected row-level release skips the model', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('Should not call model'); };
  const direct = await answerWithRag({
    message: 'Can I publish student names in a public dashboard?', intent: 'choose',
    profile: { authority: 'yes', sensitivity: 'protected' }
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(direct.status, 'review');
  const rows = await answerWithRag({
    message: 'We want to release row-level student records.', intent: 'choose',
    profile: { goal: 'statistics', holders: 'one', output: 'rows', sensitivity: 'protected', authority: 'yes' }
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(rows.status, 'review');
  const noGoal = await answerWithRag({
    message: 'Are direct identifiers okay here?', intent: 'choose',
    profile: { directRelease: 'yes', sensitivity: 'protected', authority: 'yes' }
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(noGoal.status, 'review');
  assert.equal(called, false);
});

test('fuzzy linkage presents approximate-match evidence, not exact PSI evidence', async () => {
  const model = recordingModel(ids => [{ text: 'Approximate linkage needs specialist evaluation.', source_ids: [ids[0]] }]);
  const response = await answerWithRag({
    message: 'Three agencies need fuzzy student linkage. Legal review is approved.', intent: 'choose',
    profile: { goal: 'link', holders: 'many', rawMove: 'no', match: 'fuzzy', output: 'aggregate', sensitivity: 'protected', capacity: 'medium', authority: 'yes' }
  }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'ok');
  const evidence = model.calls[0].body.contents[0].parts[0].text;
  assert.match(evidence, /nih-pprl-fuzzy/);
  assert.doesNotMatch(evidence, /ico-psi-definition/);
});

test('exact cross-holder linkage includes the PSI alternative and evidence', async () => {
  const model = recordingModel(ids => [{ text: 'PSI can compare exact overlap.', source_ids: [ids.find(id => id === 'ico-psi-definition')] }]);
  const response = await answerWithRag({
    message: 'How did MDI DC ETEP test exact linkage when raw data could not move?', intent: 'choose',
    profile: { goal: 'link', holders: 'two', rawMove: 'no', match: 'exact', output: 'aggregate', sensitivity: 'internal', capacity: 'high' }
  }, { apiKey: 'test-key', fetchImpl: model.fetchImpl });
  assert.equal(response.status, 'ok');
  assert.ok(response.sources.some(source => source.id === 'ico-psi-definition'));
  const prompt = model.calls[0].body.contents[0].parts[0].text;
  assert.match(prompt, /Private set intersection/);
  assert.match(prompt, /mdi-dc-report-triangulation/);
});

test('provider failure returns an unavailable response without provider details', async () => {
  const response = await answerWithRag({ message: 'What is differential privacy?', intent: 'learn' }, {
    apiKey: 'test-key', fetchImpl: async () => new Response('secret provider detail', { status: 503 })
  });
  assert.equal(response.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(response), /secret provider detail/);
});

test('service identity is requested for conversation and grounded answers after privacy review gates', async () => {
  const model = recordingModel(ids => ids.length
    ? [{ text: 'A cited answer.', source_ids: [ids[0]] }]
    : [{ text: 'Could you clarify?', source_ids: [] }]);
  let tokenCalls = 0;
  const options = {
    projectId: 'pets-model-123',
    accessTokenProvider: async () => { tokenCalls++; return 'test-access-token'; },
    fetchImpl: model.fetchImpl
  };
  const review = await answerWithRag({ message: 'Can we share student records under FERPA?', intent: 'learn' }, options);
  assert.equal(review.reason, 'human_review_required');
  const noEvidence = await answerWithRag({ message: 'volcanoes astrophysics xylophone', intent: 'learn' }, options);
  assert.equal(noEvidence.status, 'chat');
  assert.equal(tokenCalls, 1);
  const answer = await answerWithRag({ message: 'What is differential privacy?', intent: 'learn' }, options);
  assert.equal(answer.status, 'ok');
  assert.equal(tokenCalls, 2);
  assert.equal(model.calls[1].options.headers.authorization, 'Bearer test-access-token');
});
