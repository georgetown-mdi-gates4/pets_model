import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateNotesProvider, copiesPrivateNotes } from '../server/private-notes.mjs';
import { answerWithRag } from '../server/rag.mjs';

const privateSentence = 'The internal pilot discussion recommends reviewing borderline links with a restricted metadata view before any human access.';
const corpus = { version: 1, chunks: [{ id: 'meeting-001', text: privateSentence }] };

function modelReply(segments) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ segments }) }] } }] });
}

test('private notes load through an authenticated Secret Manager version and stay server-side', async () => {
  let calls = 0;
  const notes = createPrivateNotesProvider({
    secretVersion: 'projects/pets-model-123/secrets/nysed-meeting-notes/versions/latest',
    accessTokenProvider: async () => 'runtime-token',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://secretmanager.googleapis.com/v1/projects/pets-model-123/secrets/nysed-meeting-notes/versions/latest:access');
      assert.equal(options.headers.authorization, 'Bearer runtime-token');
      return Response.json({ payload: { data: Buffer.from(JSON.stringify(corpus)).toString('base64') } });
    }
  });
  assert.deepEqual(await notes('borderline metadata review'), [privateSentence]);
  assert.deepEqual(await notes('borderline metadata review'), [privateSentence]);
  assert.deepEqual(await notes('unrelated astronomy'), []);
  assert.equal(calls, 1);
});

test('private context may guide a cited answer but never appears in source metadata', async () => {
  let prompt;
  const response = await answerWithRag({ message: 'How should a record linkage pilot handle borderline matches?', intent: 'learn' }, {
    apiKey: 'test-key',
    privateNotesProvider: async () => [privateSentence],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      prompt = body.contents[0].parts[0].text;
      const id = body.generationConfig.responseSchema.properties.segments.items.properties.source_ids.items.enum[0];
      return modelReply([{ text: 'Evaluate uncertain matches with a controlled review step.', source_ids: [id] }]);
    }
  });
  assert.match(prompt, /private_decision_context/);
  assert.match(prompt, /borderline links/);
  assert.equal(response.status, 'ok');
  assert.ok(response.sources.length);
  assert.doesNotMatch(JSON.stringify(response), /internal pilot|meeting-001|nysed/i);
});

test('substantial private quotation is rejected before the browser sees it', async () => {
  assert.equal(copiesPrivateNotes(privateSentence, [privateSentence]), true);
  let requested = false;
  const response = await answerWithRag({ message: 'How should a record linkage pilot handle borderline matches?', intent: 'learn' }, {
    apiKey: 'test-key',
    privateNotesProvider: async () => { requested = true; return [privateSentence]; },
    fetchImpl: async (_url, options) => {
      const id = JSON.parse(options.body).generationConfig.responseSchema.properties.segments.items.properties.source_ids.items.enum[0];
      return modelReply([{ text: privateSentence, source_ids: [id] }]);
    }
  });
  assert.equal(requested, true);
  assert.equal(response.status, 'unavailable');
  assert.equal(response.reason, 'private_output_blocked');
  assert.doesNotMatch(JSON.stringify(response), /borderline links/);
});

test('greetings and direct requests for meeting notes do not retrieve private text', async () => {
  let calls = 0;
  const privateNotesProvider = async () => { calls++; return [privateSentence]; };
  const greeting = await answerWithRag({ message: 'hello', intent: 'learn' }, {
    apiKey: 'test-key', privateNotesProvider,
    fetchImpl: async () => modelReply([{ text: 'Hello!', source_ids: [] }])
  });
  assert.equal(greeting.status, 'chat');
  const request = await answerWithRag({ message: 'Please send the NYSED meeting notes', intent: 'learn' }, {
    apiKey: 'test-key', privateNotesProvider,
    fetchImpl: async () => { throw new Error('Model should not see notes'); }
  });
  assert.equal(request.status, 'chat');
  assert.equal(calls, 0);
});
