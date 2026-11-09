import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGeminiDraft } from '../server/gemini.mjs';

test('Vertex express request uses structured citations without exposing the key in the URL', async () => {
  let request;
  let usage;
  const draft = await generateGeminiDraft('Public evidence prompt', ['source-one'], {
    apiKey: 'test-key',
    onUsage: counts => { usage = counts; },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return Response.json({
        usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 24, thoughtsTokenCount: 8, totalTokenCount: 155, unrelated: 'do not log' },
        candidates: [{ finishReason: 'STOP', content: { parts: [{
          text: JSON.stringify({ segments: [{ text: 'A short answer.', source_ids: ['source-one'] }] })
        }] } }]
      });
    }
  });
  assert.deepEqual(draft.segments[0].source_ids, ['source-one']);
  assert.deepEqual(usage, { model: 'gemini-3.5-flash', promptTokenCount: 123, candidatesTokenCount: 24, thoughtsTokenCount: 8, totalTokenCount: 155 });
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
  assert.doesNotMatch(request.url, /test-key/);
  assert.equal(request.url, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash:generateContent');
  assert.equal(request.body.store, undefined);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.body.generationConfig.temperature, undefined);
  assert.equal(request.body.generationConfig.maxOutputTokens, 2048);
  assert.deepEqual(
    request.body.generationConfig.responseSchema.properties.segments.items.properties.source_ids.items.enum,
    ['source-one']
  );
});

test('project-scoped Vertex request uses its project and location, with 2.5 thinking budget', async () => {
  let request;
  await generateGeminiDraft('Prompt', ['source-one'], {
    apiKey: 'test-key', model: 'gemini-2.5-flash', projectId: 'pets-model-123', location: 'us-central1',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{
        text: JSON.stringify({ segments: [{ text: 'Answer.', source_ids: ['source-one'] }] })
      }] } }] });
    }
  });
  assert.equal(request.url, 'https://aiplatform.googleapis.com/v1/projects/pets-model-123/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent');
  assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
});

test('Cloud Run service identity uses a bearer token for project-scoped Vertex', async () => {
  let request;
  let tokenCalls = 0;
  await generateGeminiDraft('Prompt', ['source-one'], {
    projectId: 'pets-model-123',
    accessTokenProvider: async () => { tokenCalls++; return 'test-access-token'; },
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers };
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{
        text: JSON.stringify({ segments: [{ text: 'Answer.', source_ids: ['source-one'] }] })
      }] } }] });
    }
  });
  assert.equal(tokenCalls, 1);
  assert.match(request.url, /projects\/pets-model-123\/locations\/global\/publishers\/google\/models/);
  assert.equal(request.headers.authorization, 'Bearer test-access-token');
  assert.equal(request.headers['x-goog-api-key'], undefined);
  assert.doesNotMatch(request.url, /test-access-token/);
});

test('service identity fails closed when no project or token is available', async () => {
  let calls = 0;
  const accessTokenProvider = async () => { calls++; return ''; };
  const fetchImpl = async () => { throw new Error('Model must not be called'); };
  await assert.rejects(generateGeminiDraft('Prompt', ['source-one'], {
    accessTokenProvider, fetchImpl
  }), /Missing model credential/);
  assert.equal(calls, 0);
  await assert.rejects(generateGeminiDraft('Prompt', ['source-one'], {
    projectId: 'pets-model-123', accessTokenProvider, fetchImpl
  }), /Missing model credential/);
  assert.equal(calls, 1);
});

test('billing label goes into the Vertex request body only when given, and a bad label is refused before any call', async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{
      text: JSON.stringify({ segments: [{ text: 'A short answer.', source_ids: ['source-one'] }] })
    }] } }] });
  };
  const options = { accessTokenProvider: async () => 'token', projectId: 'pets-model-123', fetchImpl };
  await generateGeminiDraft('Prompt', ['source-one'], options);
  await generateGeminiDraft('Prompt', ['source-one'], { ...options, billingLabel: 'kathleen-chatbot' });
  assert.equal('labels' in bodies[0], false);
  assert.deepEqual(bodies[1].labels, { app: 'kathleen-chatbot' });
  for (const bad of ['Kathleen-Chatbot', '', 'a'.repeat(64), 'has space', 'a.b', 123]) {
    await assert.rejects(generateGeminiDraft('Prompt', ['source-one'], { ...options, billingLabel: bad }), /Invalid billing label/);
  }
  assert.equal(bodies.length, 2);
});
