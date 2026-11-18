import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { globalStore } from './lib/store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './lib/gitproto.ts';
import { handleRestApi, sendJson } from './lib/rest.ts';
import { handleGraphqlApi } from './lib/graphql.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
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

      if (path.startsWith('/api/v3')) {
        const handled = await handleRestApi(req, res, globalStore);
        if (handled) return;
      }

      if (path === '/api/graphql') {
        const handled = await handleGraphqlApi(req, res, globalStore);
        if (handled) return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  });
}
