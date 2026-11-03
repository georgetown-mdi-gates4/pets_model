import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCloudRunServer } from '../cloud-run/server.mjs';
import { createDailyModelBudget } from '../cloud-run/budget.mjs';
import { createMetadataAccessTokenProvider } from '../cloud-run/metadata.mjs';

async function withServer(server, run) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('Cloud Run adapter serves the public UI without exposing server files', async () => {
  const server = createCloudRunServer({ projectId: 'valid-project' });
  await withServer(server, async base => {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /PETs Model/);

    const script = await fetch(`${base}/app.mjs`, { method: 'HEAD' });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/javascript/);
    assert.equal(script.headers.get('cache-control'), 'no-cache');
    assert.equal(await script.text(), '');

    const sources = await fetch(`${base}/data/sources.json`, { method: 'HEAD' });
    assert.equal(sources.status, 200);
    assert.equal(sources.headers.get('cache-control'), 'no-cache');

    assert.equal((await fetch(`${base}/server/gemini.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e%2fserver/gemini.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  });
});

test('Cloud Run adapter rejects a symlink that leaves the public directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pets-cloud-run-'));
  const publicRoot = join(directory, 'public');
  await mkdir(publicRoot);
  await writeFile(join(directory, 'private.txt'), 'PRIVATE');
  await symlink(join(directory, 'private.txt'), join(publicRoot, 'leak.txt'));
  try {
    const server = createCloudRunServer({ publicRoot, projectId: 'valid-project' });
    await withServer(server, async base => {
      const response = await fetch(`${base}/leak.txt`);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /PRIVATE/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Cloud Run adapter bounds chat bodies and ignores caller credential and rate headers', async () => {
  const calls = [];
  const accessTokenProvider = async () => 'metadata-token';
  const server = createCloudRunServer({
    projectId: 'valid-project',
    location: 'global',
    accessTokenProvider,
    chatHandler: async (request, options) => {
      calls.push({ request, options, body: await request.text() });
      return Response.json({ status: 'ok' });
    }
  });
  await withServer(server, async base => {
    const send = (forwarded, body = '{}') => fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': forwarded,
        'oai-authenticated-user-id': 'forged-user',
        'x-goog-api-key': 'forged-key',
        authorization: 'Bearer forged',
        origin: `https://127.0.0.1:${server.address().port}`
      },
      body
    });
    assert.equal((await send('spoof-a, 203.0.113.8, 130.211.1.1')).status, 200);
    assert.equal((await send('spoof-b, 203.0.113.8, 130.211.1.1')).status, 200);
    assert.equal((await send('spoof-a, 203.0.113.9, 130.211.1.1')).status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].request.url, `https://127.0.0.1:${server.address().port}/api/chat`);
    assert.equal(calls[0].request.headers.get('oai-authenticated-user-id'), null);
    assert.equal(calls[0].request.headers.get('x-goog-api-key'), null);
    assert.equal(calls[0].request.headers.get('authorization'), null);
    assert.equal(calls[0].options.requireIdentity, false);
    assert.equal(calls[0].options.accessTokenProvider, accessTokenProvider);
    assert.equal(calls[0].options.projectId, 'valid-project');
    assert.equal(calls[0].options.model, 'gemini-3.5-flash');
    assert.equal(calls[0].options.rateKey, 'public-cloud-run');
    assert.equal(calls[0].options.rateKey, calls[1].options.rateKey);
    assert.equal(calls[0].options.rateKey, calls[2].options.rateKey);
    assert.equal(typeof calls[0].options.reserveModelCall, 'function');
    assert.equal(calls[0].body, '{}');

    assert.equal((await send('spoof-a, 203.0.113.8, 130.211.1.1', 'x'.repeat(8193))).status, 413);
    assert.equal(calls.length, 3);
  });
});

test('Cloud Run adapter reaches the shared chat validation boundary', async () => {
  const server = createCloudRunServer({
    projectId: 'valid-project',
    accessTokenProvider: async () => { throw new Error('Should not fetch a token'); }
  });
  await withServer(server, async base => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON.' });
  });
});

test('Cloud Run paid-call cap is atomic within a process and resets each UTC day', async () => {
  let now = Date.parse('2026-10-14T23:59:00Z');
  const reserve = createDailyModelBudget({ now: () => now, limit: 2 });
  assert.deepEqual(await Promise.all([reserve(), reserve(), reserve()]), [true, true, false]);
  now = Date.parse('2026-10-15T00:00:00Z');
  assert.equal(await reserve(), true);
});

test('Cloud Run metadata provider shares and refreshes short-lived tokens', async () => {
  let now = 0;
  let fetches = 0;
  const provider = createMetadataAccessTokenProvider({
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.match(url, /metadata\.google\.internal/);
      assert.equal(options.headers['Metadata-Flavor'], 'Google');
      fetches++;
      return Response.json({ access_token: `token-${fetches}`, expires_in: 3600 });
    }
  });
  const [first, concurrent] = await Promise.all([provider(), provider()]);
  assert.equal(first, 'token-1');
  assert.equal(concurrent, 'token-1');
  assert.equal(fetches, 1);
  now = 3_000_000;
  assert.equal(await provider(), 'token-1');
  now = 3_301_000;
  assert.equal(await provider(), 'token-2');
  assert.equal(fetches, 2);
});

test('Cloud Run adapter requires a real project ID', () => {
  assert.throws(() => createCloudRunServer({ projectId: '' }), /VERTEX_PROJECT_ID/);
  assert.throws(() => createCloudRunServer({ projectId: '123456' }), /VERTEX_PROJECT_ID/);
});
