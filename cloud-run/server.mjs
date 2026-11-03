import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleChatRequest } from '../server/http.mjs';
import { createDailyModelBudget } from './budget.mjs';
import { createMetadataAccessTokenProvider } from './metadata.mjs';

const PUBLIC_ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const MAX_BODY_BYTES = 8192;
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);

function sendText(response, status, body, method = 'GET') {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(method === 'HEAD' ? undefined : bytes);
}

function readBoundedBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const statedLength = Number(request.headers['content-length']);
    if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) {
      resolveBody(null);
      return;
    }
    let bytes = 0;
    const chunks = [];
    function cleanup() {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAbort);
    }
    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        request.pause();
        cleanup();
        resolveBody(null);
      } else {
        chunks.push(chunk);
      }
    }
    function onEnd() {
      cleanup();
      resolveBody(Buffer.concat(chunks, bytes));
    }
    function onError(error) {
      cleanup();
      rejectBody(error);
    }
    function onAbort() {
      onError(new Error('Request aborted'));
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAbort);
  });
}

function webHeaders(request) {
  const headers = new Headers();
  // Only validation headers cross into the shared handler. Browser-supplied
  // identity, Authorization, or provider-key headers are intentionally ignored.
  for (const name of ['origin', 'content-type']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

async function sendWebResponse(nodeResponse, webResponse) {
  const headers = Object.fromEntries(webResponse.headers);
  nodeResponse.writeHead(webResponse.status, headers);
  nodeResponse.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function serveStatic(request, response, pathname, publicRoot) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed.', request.method);
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, 'Invalid path.', request.method);
    return;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    sendText(response, 400, 'Invalid path.', request.method);
    return;
  }
  const candidate = resolve(publicRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
  const candidateRelative = relative(publicRoot, candidate);
  if (candidateRelative.startsWith(`..${sep}`) || candidateRelative === '..' ||
      candidateRelative.startsWith(sep) || candidateRelative === '') {
    sendText(response, 404, 'Not found.', request.method);
    return;
  }
  try {
    const actual = await realpath(candidate);
    const actualRelative = relative(publicRoot, actual);
    if (actualRelative.startsWith(`..${sep}`) || actualRelative === '..' || actualRelative.startsWith(sep)) {
      sendText(response, 404, 'Not found.', request.method);
      return;
    }
    const info = await stat(actual);
    if (!info.isFile()) {
      sendText(response, 404, 'Not found.', request.method);
      return;
    }
    response.writeHead(200, {
      'content-type': MIME.get(extname(actual)) || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(actual).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') sendText(response, 404, 'Not found.', request.method);
    else sendText(response, 500, 'Server error.', request.method);
  }
}

/** Minimal same-origin adapter for the public UI and shared chat boundary. */
export function createCloudRunServer({
  publicRoot = PUBLIC_ROOT,
  chatHandler = handleChatRequest,
  accessTokenProvider = createMetadataAccessTokenProvider(),
  reserveModelCall = createDailyModelBudget(),
  projectId = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
  location = process.env.VERTEX_LOCATION || 'global',
  model = process.env.GEMINI_MODEL || 'gemini-3.5-flash'
} = {}) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new Error('VERTEX_PROJECT_ID must be a valid Google Cloud project ID');
  }
  const root = resolve(publicRoot);
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
        sendText(response, 400, 'Invalid path.', request.method);
        return;
      }
      const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const url = new URL(request.url, `${protocol}://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        sendText(response, 200, 'ok', request.method);
      } else if (url.pathname === '/api/chat') {
        const body = request.method === 'POST' ? await readBoundedBody(request) : undefined;
        if (body === null) {
          response.shouldKeepAlive = false;
          response.setHeader('connection', 'close');
          sendText(response, 413, 'Message is too long.', request.method);
          return;
        }
        const webRequest = new Request(url, {
          method: request.method,
          headers: webHeaders(request),
          ...(body ? { body } : {})
        });
        const webResponse = await chatHandler(webRequest, {
          accessTokenProvider,
          projectId,
          location,
          model,
          requireIdentity: false,
          rateKey: 'public-cloud-run',
          reserveModelCall,
          onUsage: usage => console.info(JSON.stringify({ event: 'gemini_usage', ...usage }))
        });
        await sendWebResponse(response, webResponse);
      } else if (url.pathname.startsWith('/api/')) {
        sendText(response, 404, 'Not found.', request.method);
      } else {
        await serveStatic(request, response, url.pathname, root);
      }
    } catch {
      if (!response.headersSent) sendText(response, 500, 'Server error.', request.method);
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  createCloudRunServer().listen(port, '0.0.0.0', () => {
    console.log(`PETs Model listening on port ${port}`);
  });
}
