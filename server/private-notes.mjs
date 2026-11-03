import { tokens } from '../public/retrieval.mjs';

const MAX_SECRET_BYTES = 64 * 1024;
const CACHE_MS = 10 * 60 * 1000;

function validVersion(name) {
  return /^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/secrets\/[a-zA-Z0-9_-]{1,255}\/versions\/(?:latest|[1-9][0-9]*)$/.test(name || '');
}

function validateCorpus(value) {
  if (value?.version !== 1 || !Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > 120) {
    throw new Error('Invalid private notes corpus');
  }
  const ids = new Set();
  const chunks = value.chunks.map(chunk => {
    if (typeof chunk?.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(chunk.id) || ids.has(chunk.id) ||
        typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > 1300) {
      throw new Error('Invalid private notes chunk');
    }
    ids.add(chunk.id);
    return { id: chunk.id, text: chunk.text.trim() };
  });
  return chunks;
}

/** Fetches one restricted Secret Manager version; no notes enter the image or browser. */
export function createPrivateNotesProvider({ secretVersion, accessTokenProvider, fetchImpl = fetch, now = Date.now } = {}) {
  if (!secretVersion) return async () => [];
  if (!validVersion(secretVersion)) throw new Error('Invalid private notes secret version');
  if (typeof accessTokenProvider !== 'function') throw new Error('Private notes require service identity');
  let cached;
  let expiresAt = 0;
  let inFlight;
  async function load() {
    if (cached && now() < expiresAt) return cached;
    if (!inFlight) inFlight = (async () => {
      const token = await accessTokenProvider();
      const url = `https://secretmanager.googleapis.com/v1/${secretVersion}:access`;
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error('Private notes unavailable');
      const payload = await response.json();
      if (typeof payload?.payload?.data !== 'string') throw new Error('Invalid private notes payload');
      const body = Buffer.from(payload.payload.data, 'base64');
      if (!body.length || body.length > MAX_SECRET_BYTES) throw new Error('Private notes payload too large');
      cached = validateCorpus(JSON.parse(body.toString('utf8')));
      expiresAt = now() + CACHE_MS;
      return cached;
    })();
    try { return await inFlight; } finally { inFlight = undefined; }
  }
  return async function privateNotes(query, limit = 3) {
    const chunks = await load();
    const terms = new Set(tokens(query));
    if (!terms.size) return [];
    const scored = chunks.map(chunk => {
      const words = tokens(chunk.text);
      const seen = new Set(words);
      const overlap = [...terms].filter(term => seen.has(term));
      const score = overlap.length / Math.sqrt(Math.max(1, words.length));
      return { chunk, score, overlap: overlap.length };
    }).filter(hit => hit.overlap >= 2);
    scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    return scored.slice(0, Math.max(0, Math.min(3, limit))).map(hit => hit.chunk.text);
  };
}

/** Fail closed if a generated answer reproduces a substantial span of private notes. */
export function copiesPrivateNotes(answer, notes) {
  if (!notes?.length) return false;
  const words = tokens(answer);
  if (words.length < 6) return false;
  const phrases = new Set();
  for (const note of notes) {
    const source = tokens(note);
    for (let i = 0; i <= source.length - 6; i++) phrases.add(source.slice(i, i + 6).join(' '));
  }
  for (let i = 0; i <= words.length - 6; i++) {
    if (phrases.has(words.slice(i, i + 6).join(' '))) return true;
  }
  return false;
}
