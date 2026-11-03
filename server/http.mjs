import { answerWithRag } from './rag.mjs';

const MAX_BODY_BYTES = 8192;
const MAX_MESSAGE_CHARS = 1200;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_TRACKED_IDENTITIES = 4096;
const PRUNE_INTERVAL_MS = 60 * 1000;
// Best-effort abuse control within one worker isolate, not a global rate limit.
const recentRequests = new Map();
let nextPruneAt = 0;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

function permitted(identity, now) {
  if (now >= nextPruneAt) {
    for (const [key, times] of recentRequests) {
      const active = times.filter(time => now - time < WINDOW_MS);
      if (active.length) recentRequests.set(key, active);
      else recentRequests.delete(key);
    }
    nextPruneAt = now + PRUNE_INTERVAL_MS;
  }
  const prior = (recentRequests.get(identity) || []).filter(time => now - time < WINDOW_MS);
  if (!prior.length) recentRequests.delete(identity);
  if (prior.length >= MAX_REQUESTS_PER_WINDOW) return false;
  if (!recentRequests.has(identity) && recentRequests.size >= MAX_TRACKED_IDENTITIES) return false;
  prior.push(now);
  recentRequests.set(identity, prior);
  return true;
}

async function readLimitedBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The size limit still applies. */ }
        return null;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Thin HTTP boundary shared by the authenticated Site and a public Worker. */
export async function handleChatRequest(request, {
  apiKey, accessTokenProvider, model, projectId, location, fetchImpl, reserveModelCall, onUsage, privateNotesProvider, answer = answerWithRag, requireIdentity = true,
  rateKey, now = Date.now()
} = {}) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const identity = request.headers.get('oai-authenticated-user-id');
  if (requireIdentity && !identity) return json({ error: 'Sign in to use the model.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Invalid request origin.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return json({ error: 'Expected JSON.' }, 415);
  }
  const statedLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) return json({ error: 'Message is too long.' }, 413);

  let input;
  try {
    const body = await readLimitedBody(request);
    if (body === null) return json({ error: 'Message is too long.' }, 413);
    input = JSON.parse(body);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.message !== 'string' || !input.message.trim() || input.message.length > MAX_MESSAGE_CHARS ||
      !['learn', 'choose', 'plan'].includes(input.intent)) {
    return json({ error: 'Invalid question.' }, 400);
  }
  // An external host can supply a trusted visitor key; request headers are never trusted for it.
  if (!permitted(rateKey || identity || 'local-preview', now)) return json({ error: 'Please wait before trying again.' }, 429);

  try {
    const result = await answer({
      message: input.message,
      intent: input.intent,
      profile: input.profile,
      context: input.context
    }, { apiKey, accessTokenProvider, model, projectId, location, fetchImpl, reserveModelCall, onUsage, privateNotesProvider });
    return json(result);
  } catch {
    return json({ status: 'unavailable', segments: [], sources: [], reason: 'server_error' }, 503);
  }
}
