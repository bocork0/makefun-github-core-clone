// app.ts — the HTTP server: routing, auth, request ids and body handling for
// the git smart-HTTP, REST v3, GraphQL and MCP surfaces of the forge.

import http from 'node:http';
import { Store } from './store.ts';
import { handleFetch, handleInfoRefs, handleLsRefs, handlePush } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token the suite configured, or null when running locally. */
export function configuredToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

function authorized(req: http.IncomingMessage, token: string | null): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  if (token !== null) return presented === token;
  return true;
}

export function createServer(store: Store, token: string | null): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const origin = `http://${req.headers.host ?? 'localhost'}`;

        // Health, no auth.
        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          if (owner !== store.viewer.login) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const gitProtocol = req.headers['git-protocol'];
          const protocol2 = gitProtocol === 'version=2';
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const result = handleInfoRefs(repo, service, protocol2);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const firstLine = body.toString('utf8', 0, Math.min(body.length, 64));
            if (firstLine.startsWith('001fcommand=ls-refs') || firstLine.includes('command=ls-refs')) {
              const result = handleLsRefs(repo, body);
              sendBuffer(res, result.status, result.body, result.contentType);
            } else {
              const result = handleFetch(repo, body, protocol2);
              sendBuffer(res, result.status, result.body, result.contentType);
            }
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = handlePush(repo, body);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // MCP: raw body, its own JSON-RPC parse errors.
        if (pathname === '/mcp') {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const body = await readBody(req);
          const result = handleMcp(store, origin, method, body);
          sendJson(res, result.status, result.body);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql' && method === 'POST') {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const result = handleGraphql(store, origin, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          let parsed: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const result = handleRest(store, origin, method, pathname, url.searchParams, parsed);
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
  // The benchmark holds one keep-alive connection for 2,000 sequential reads.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
