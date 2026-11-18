import { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryStore, now } from './store.ts';
import { formatRepo, formatIssue, formatPull, sendJson } from './rest.ts';
import { performSquashMerge } from './merge.ts';

const MCP_TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository details',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name owner/repo' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name owner/repo' },
        state: { type: 'string', description: 'Issue state (open, closed, all)' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number' },
      },
      required: [],
    },
  },
]);

const TOOLS_LIST_JSON = JSON.stringify({ tools: MCP_TOOLS });

function parseOwnerRepo(args: any): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' && args.owner.trim() !== '' ? args.owner : 'adaiversen';
  let repo = typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo : '';

  const fullName = args.full_name || args.repo_full_name || args.fullName;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const parts = fullName.split('/', 2);
    if (parts[0] && parts[1]) {
      owner = parts[0];
      repo = parts[1];
    }
  }
  return { owner, repo };
}

export async function handleMcpApi(req: IncomingMessage, res: ServerResponse, store: MemoryStore): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (method !== 'POST') return false;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyBuf = Buffer.concat(chunks);
  const bodyText = bodyBuf.toString('utf8');

  let body: any;
  try {
    body = bodyText.trim() === '' ? {} : JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error: invalid JSON',
      },
    }));
    return true;
  }

  const handleSingle = async (reqObj: any): Promise<any> => {
    if (!reqObj || typeof reqObj !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const id = reqObj.id !== undefined ? reqObj.id : null;
    const jsonrpc = reqObj.jsonrpc || '2.0';
    const methodStr = reqObj.method;
    const params = reqObj.params || {};

    if (methodStr === 'server/discover') {
      return {
        jsonrpc,
        id,
        result: {
          resultType: 'discover',
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: {} },
          serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'makefun-github-core-clone', version: '1.0.0' },
          },
        },
      };
    }

    if (methodStr === 'initialize') {
      const requestedVersion = params.protocolVersion || '2025-11-25';
      return {
        jsonrpc,
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
        },
      };
    }

    if (methodStr === 'notifications/initialized') {
      return null;
    }

    if (methodStr === 'tools/list') {
      return {
        jsonrpc,
        id,
        result: JSON.parse(TOOLS_LIST_JSON),
      };
    }

    if (methodStr === 'tools/call') {
      const toolName = params.name;
      const args = params.arguments || {};

      if (!toolName || typeof toolName !== 'string') {
        return {
          jsonrpc,
          id,
          error: { code: -32602, message: 'Missing tool name' },
        };
      }

      const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = (canonical: string) => {
        const normCanonical = canonical.toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalized === normCanonical || normalized.endsWith(normCanonical);
      };

      try {
        if (match('create_repo')) {
          const name = args.name || args.repo || args.repository;
          if (!name || typeof name !== 'string') {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: 'Missing required argument: name' }],
                isError: true,
              },
            };
          }
          const owner = typeof args.owner === 'string' && args.owner.trim() !== '' ? args.owner : 'adaiversen';
          const description = typeof args.description === 'string' ? args.description : '';
          const isPrivate = !!args.private;
          
          let repoObj;
          try {
            repoObj = store.createRepo(owner, name, description, isPrivate);
          } catch (e: any) {
            repoObj = store.getRepo(owner, name);
            if (!repoObj) throw e;
          }
          const formatted = formatRepo(repoObj);
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          };
        }

        if (match('get_repo')) {
          const { owner, repo } = parseOwnerRepo(args);
          const repoObj = store.getRepo(owner, repo);
          if (!repoObj) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: `Repository ${owner}/${repo} not found` }],
                isError: true,
              },
            };
          }
          const formatted = formatRepo(repoObj);
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          };
        }

        if (match('create_issue')) {
          const { owner, repo } = parseOwnerRepo(args);
          const title = args.title;
          if (!title || typeof title !== 'string') {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: 'Missing required argument: title' }],
                isError: true,
              },
            };
          }
          const repoObj = store.getRepo(owner, repo);
          if (!repoObj) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: `Repository ${owner}/${repo} not found` }],
                isError: true,
              },
            };
          }
          const repoKey = `${owner}/${repo}`.toLowerCase();
          const issuesList = store.issues.get(repoKey) ?? [];
          const issueId = ++store.issueIdCounter;
          const issueNumber = issuesList.length + 1;
          const user = store.users.get(owner.toLowerCase()) || { id: 1000, login: owner, name: owner, email: `${owner}@example.invalid` };
          
          const issue = {
            id: issueId,
            number: issueNumber,
            owner,
            repo,
            title,
            body: typeof args.body === 'string' ? args.body : '',
            state: 'open' as const,
            labels: [],
            user,
            createdAt: now(),
            updatedAt: now(),
            commentsCount: 0,
          };
          issuesList.push(issue);
          store.issues.set(repoKey, issuesList);

          const formatted = formatIssue(issue, repoObj);
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          };
        }

        if (match('list_issues')) {
          const { owner, repo } = parseOwnerRepo(args);
          const repoObj = store.getRepo(owner, repo);
          if (!repoObj) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: `Repository ${owner}/${repo} not found` }],
                isError: true,
              },
            };
          }
          const repoKey = `${owner}/${repo}`.toLowerCase();
          const issuesList = store.issues.get(repoKey) ?? [];
          const formatted = issuesList.map(i => formatIssue(i, repoObj));
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          };
        }

        if (match('create_pull_request')) {
          const { owner, repo } = parseOwnerRepo(args);
          const title = args.title;
          const head = args.head;
          const base = args.base;
          if (!title || !head || !base) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: title, head, base' }],
                isError: true,
              },
            };
          }
          const repoObj = store.getRepo(owner, repo);
          if (!repoObj) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: `Repository ${owner}/${repo} not found` }],
                isError: true,
              },
            };
          }
          const repoKey = `${owner}/${repo}`.toLowerCase();
          const pullsList = store.pulls.get(repoKey) ?? [];
          const pullId = ++store.pullIdCounter;
          const pullNumber = pullsList.length + 1;
          const user = store.users.get(owner.toLowerCase()) || { id: 1000, login: owner, name: owner, email: `${owner}@example.invalid` };

          const pull = {
            id: pullId,
            number: pullNumber,
            owner,
            repo,
            title,
            body: typeof args.body === 'string' ? args.body : '',
            state: 'open' as const,
            merged: false,
            head,
            base,
            user,
            createdAt: now(),
            updatedAt: now(),
            files: [],
          };
          pullsList.push(pull);
          store.pulls.set(repoKey, pullsList);

          const formatted = formatPull(pull, repoObj, store);
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          };
        }

        if (match('merge_pull_request')) {
          const { owner, repo } = parseOwnerRepo(args);
          const pullNumber = Number(args.pull_number ?? args.number ?? args.pullRequestNumber);
          if (!Number.isInteger(pullNumber)) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: 'Missing or invalid pull_number' }],
                isError: true,
              },
            };
          }
          const mergeResult = performSquashMerge(store, owner, repo, pullNumber, args.commit_message);
          if (mergeResult.status !== 200) {
            return {
              jsonrpc,
              id,
              result: {
                content: [{ type: 'text', text: mergeResult.body.message || 'Merge failed' }],
                isError: true,
              },
            };
          }
          return {
            jsonrpc,
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(mergeResult.body) }],
              structuredContent: mergeResult.body,
            },
          };
        }

        return {
          jsonrpc,
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
        };
      } catch (err: any) {
        return {
          jsonrpc,
          id,
          result: {
            content: [{ type: 'text', text: err.message || 'Internal tool execution error' }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc,
      id,
      error: {
        code: -32601,
        message: `Unknown method: ${methodStr}`,
      },
    };
  };

  if (Array.isArray(body)) {
    const responses = [];
    for (const item of body) {
      const resItem = await handleSingle(item);
      if (resItem !== null) responses.push(resItem);
    }
    sendJson(res, 200, responses);
    return true;
  } else {
    const resItem = await handleSingle(body);
    if (resItem === null) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}\n');
      return true;
    }
    sendJson(res, 200, resItem);
    return true;
  }
}
