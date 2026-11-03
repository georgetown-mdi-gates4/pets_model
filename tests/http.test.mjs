import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChatRequest } from '../server/http.mjs';

const url = 'https://pets-model.example/api/chat';
const valid = { message: 'Explain differential privacy', intent: 'learn', profile: {}, context: [] };
function request(body = valid, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://pets-model.example',
      'oai-authenticated-user-id': 'user-1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('chat endpoint requires a Sites identity before using the model', async () => {
  let called = false;
  const response = await handleChatRequest(request(valid, { 'oai-authenticated-user-id': '' }), {
    answer: async () => { called = true; return {}; }
  });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test('chat endpoint rejects cross-origin and oversized messages', async () => {
  const crossOrigin = await handleChatRequest(request(valid, { origin: 'https://elsewhere.example' }));
  assert.equal(crossOrigin.status, 403);
  const oversized = await handleChatRequest(request({ ...valid, message: 'x'.repeat(1201) }));
  assert.equal(oversized.status, 400);
});

test('chat endpoint rejects a body larger than 8 KB even with a forged length', async () => {
  let called = false;
  const body = JSON.stringify({ ...valid, context: [{ role: 'user', text: 'x'.repeat(9000) }] });
  const response = await handleChatRequest(request(body, { 'content-length': '1' }), {
    answer: async () => { called = true; return {}; }
  });
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

test('chat endpoint passes bounded request fields and returns private, uncached JSON', async () => {
  let received;
  const response = await handleChatRequest(request({ ...valid, extra: 'discard me' }), {
    apiKey: 'test-key', model: 'gemini-test', projectId: 'pets-model-123', location: 'global',
    answer: async (input, options) => {
      received = { input, options };
      return { status: 'ok', segments: [{ text: 'A cited answer.', source_ids: ['a'] }], sources: [] };
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'ok');
  assert.equal(received.input.extra, undefined);
  assert.equal(received.options.apiKey, 'test-key');
  assert.equal(received.options.projectId, 'pets-model-123');
  assert.equal(received.options.location, 'global');
});

test('chat endpoint limits repeated model calls for one identity', async () => {
  const limitedRequest = () => request(valid, { 'oai-authenticated-user-id': 'rate-test' });
  const answer = async () => ({ status: 'ok', segments: [], sources: [] });
  for (let i = 0; i < 60; i++) {
    const response = await handleChatRequest(limitedRequest(), { now: 10000 + i, answer });
    assert.equal(response.status, 200);
  }
  assert.equal((await handleChatRequest(limitedRequest(), { now: 10060, answer })).status, 429);
  assert.equal((await handleChatRequest(limitedRequest(), { now: 610000, answer })).status, 200);
});

test('anonymous host rate key is supplied by the server, not a visitor identity header', async () => {
  const answer = async () => ({ status: 'ok', segments: [], sources: [] });
  const anonymous = () => request(valid, { 'oai-authenticated-user-id': 'forged-identity' });
  for (let i = 0; i < 60; i++) {
    const response = await handleChatRequest(anonymous(), {
      requireIdentity: false, rateKey: 'visitor-a', now: 2000000 + i, answer
    });
    assert.equal(response.status, 200);
  }
  assert.equal((await handleChatRequest(anonymous(), {
    requireIdentity: false, rateKey: 'visitor-a', now: 2000060, answer
  })).status, 429);
  assert.equal((await handleChatRequest(anonymous(), {
    requireIdentity: false, rateKey: 'visitor-b', now: 2000061, answer
  })).status, 200);
});

test('anonymous Cloud Run boundary passes service identity to the RAG layer', async () => {
  let received;
  const accessTokenProvider = async () => 'test-access-token';
  const response = await handleChatRequest(request(valid, { 'oai-authenticated-user-id': '' }), {
    requireIdentity: false, rateKey: 'cloud-run-test', projectId: 'pets-model-123',
    accessTokenProvider,
    answer: async (_input, options) => {
      received = options;
      return { status: 'ok', segments: [], sources: [] };
    }
  });
  assert.equal(response.status, 200);
  assert.equal(received.accessTokenProvider, accessTokenProvider);
  assert.equal(received.projectId, 'pets-model-123');
});
