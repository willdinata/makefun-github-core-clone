import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { globalStore } from './lib/store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './lib/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const authHeader = req.headers['authorization'];
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
    if (expectedToken && path.startsWith('/api/')) {
      if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
    }

    if (path.includes('.git/')) {
      const urlObj = new URL(req.url ?? '/', 'http://entry');
      const pathname = urlObj.pathname;
      const queryService = urlObj.searchParams.get('service') ?? '';

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const bodyBuf = Buffer.concat(chunks);

      if (pathname.endsWith('/info/refs')) {
        const result = handleInfoRefs(pathname, queryService, globalStore);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      } else if (pathname.endsWith('/git-upload-pack')) {
        const result = handleUploadPack(pathname, bodyBuf, globalStore);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      } else if (pathname.endsWith('/git-receive-pack')) {
        const result = handleReceivePack(pathname, bodyBuf, globalStore);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      }
    }

    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
