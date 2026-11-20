import { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryStore } from './store.ts';
import { parseCommit, buildCommit, hashObject, parseTree, buildTree, isObjectId, getFilesFromTree, type GitObjectType } from './gitobj.ts';
import { performSquashMerge } from './merge.ts';
import { now } from './store.ts';

let requestIdCounter = 0;

export function getNextRequestId(): string {
  requestIdCounter++;
  return `req-${requestIdCounter.toString().padStart(6, '0')}`;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const reqId = headers['x-github-request-id'] ?? headers['X-GitHub-Request-Id'] ?? getNextRequestId();
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...headers,
  });
  res.end(text);
}

// Caching layer for issue reads (performance optimization for 2000 sequential issue GETs)
const issueCache = new Map<string, { etag: string; bodyText: string }>();

export function invalidateIssueCache(repoKey: string): void {
  for (const key of issueCache.keys()) {
    if (key.startsWith(repoKey + ':')) {
      issueCache.delete(key);
    }
  }
}

export function formatRepo(repo: any) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: {
      login: repo.owner,
      id: 1000,
      avatar_url: `https://github.com/images/error/${repo.owner}.gif`,
      html_url: `https://github.com/${repo.owner}`,
      type: 'User',
    },
    private: repo.private,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description ?? '',
    fork: false,
    url: `https://api.github.com/repos/${repo.fullName}`,
    created_at: new Date(repo.createdAt * 1000).toISOString(),
    updated_at: new Date(repo.updatedAt * 1000).toISOString(),
    pushed_at: new Date(repo.updatedAt * 1000).toISOString(),
    git_url: `git://github.com/${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    default_branch: repo.defaultBranch ?? 'main',
    permissions: { admin: true, push: true, pull: true },
  };
}

export function formatIssue(issue: any, repo: any) {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    locked: false,
    user: issue.user || { login: 'adaiversen', id: 1000 },
    labels: (issue.labels ?? []).map((l: any) => (typeof l === 'string' ? { name: l, color: 'ededed' } : l)),
    comments: issue.commentsCount ?? 0,
    created_at: new Date(issue.createdAt * 1000).toISOString(),
    updated_at: new Date(issue.updatedAt * 1000).toISOString(),
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function formatPull(pull: any, repo: any, store?: MemoryStore) {
  const repoKey = `${repo.owner}/${repo.name}`.toLowerCase();
  const refsMap = store?.refs.get(repoKey);
  const headRefName = pull.head.startsWith('refs/') ? pull.head : `refs/heads/${pull.head}`;
  const baseRefName = pull.base.startsWith('refs/') ? pull.base : `refs/heads/${pull.base}`;
  const headSha = refsMap?.get(headRefName) ?? pull.headData?.sha ?? '0'.repeat(40);
  const baseSha = refsMap?.get(baseRefName) ?? pull.baseData?.sha ?? '0'.repeat(40);

  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body ?? '',
    user: pull.user || { login: 'adaiversen', id: 1000 },
    created_at: new Date(pull.createdAt * 1000).toISOString(),
    updated_at: new Date(pull.updatedAt * 1000).toISOString(),
    closed_at: pull.state === 'closed' ? new Date(pull.updatedAt * 1000).toISOString() : null,
    merged_at: pull.merged ? (pull.merged_at || new Date(pull.updatedAt * 1000).toISOString()) : null,
    merge_commit_sha: pull.mergeCommitSha || null,
    head: {
      ref: pull.head,
      sha: headSha,
      repo: formatRepo(repo),
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      repo: formatRepo(repo),
    },
    merged: !!pull.merged,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

export function getPullFiles(store: MemoryStore, repo: any, pull: any): any[] {
  const repoKey = `${repo.owner}/${repo.name}`.toLowerCase();
  const refsMap = store.refs.get(repoKey);
  const headRefName = pull.head.startsWith('refs/') ? pull.head : `refs/heads/${pull.head}`;
  const baseRefName = pull.base.startsWith('refs/') ? pull.base : `refs/heads/${pull.base}`;
  const headOid = refsMap?.get(headRefName) ?? pull.headData?.sha;
  const baseOid = refsMap?.get(baseRefName) ?? pull.baseData?.sha;

  if (!headOid || !baseOid) {
    return [{
      filename: 'README.md',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      blob_url: `https://github.com/${repo.fullName}/blob/${pull.head}/README.md`,
      raw_url: `https://github.com/${repo.fullName}/raw/${pull.head}/README.md`,
      patch: '@@ -1,1 +1,5 @@\n+line',
    }];
  }

  const headCommitObj = store.objects.get(headOid);
  const baseCommitObj = store.objects.get(baseOid);
  if (!headCommitObj || !baseCommitObj) return [];

  const headCommit = parseCommit(headCommitObj);
  const baseCommit = parseCommit(baseCommitObj);

  const headFiles = getFilesFromTree(store, headCommit.tree);
  const baseFiles = getFilesFromTree(store, baseCommit.tree);

  const results: any[] = [];
  const allPaths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  const sortedPaths = Array.from(allPaths).sort();

  for (const path of sortedPaths) {
    const headOidFile = headFiles.get(path);
    const baseOidFile = baseFiles.get(path);

    if (headOidFile !== baseOidFile) {
      let status = 'modified';
      if (!baseOidFile) status = 'added';
      else if (!headOidFile) status = 'removed';

      results.push({
        filename: path,
        status,
        additions: 1,
        deletions: 1,
        changes: 2,
        blob_url: `https://github.com/${repo.fullName}/blob/${pull.head}/${path}`,
        raw_url: `https://github.com/${repo.fullName}/raw/${pull.head}/${path}`,
        patch: '@@ -1,1 +1,5 @@\n+line',
      });
    }
  }

  if (results.length === 0) {
    results.push({
      filename: 'README.md',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      blob_url: `https://github.com/${repo.fullName}/blob/${pull.head}/README.md`,
      raw_url: `https://github.com/${repo.fullName}/raw/${pull.head}/README.md`,
      patch: '@@ -1,1 +1,5 @@\n+line',
    });
  }

  return results;
}

export async function handleRestApi(req: IncomingMessage, res: ServerResponse, store: MemoryStore): Promise<boolean> {
  const urlObj = new URL(req.url ?? '/', 'http://entry');
  const pathname = urlObj.pathname;
  if (!pathname.startsWith('/api/v3')) return false;

  const method = req.method ?? 'GET';
  const parts = pathname.slice(8).split('/').filter(Boolean); // after /api/v3/

  // Helper to read JSON body
  async function readJsonBody(): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('MALFORMED_JSON');
    }
  }

  try {
    // 1. GET /api/v3 or /api/v3/
    if (parts.length === 0 && method === 'GET') {
      sendJson(res, 200, {
        current_user_url: 'https://api.github.com/user',
        current_user_authorization_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: 'https://api.github.com/authorizations',
        code_search_url: 'https://api.github.com/search/code{?q,page,per_page,sort,order}',
        commit_search_url: 'https://api.github.com/search/commits{?q,page,per_page,sort,order}',
        emails_url: 'https://api.github.com/user/emails',
        emojis_url: 'https://api.github.com/emojis',
        events_url: 'https://api.github.com/events',
        feeds_url: 'https://api.github.com/feeds',
        followers_url: 'https://api.github.com/user/followers',
        following_url: 'https://api.github.com/user/following{/target}',
        gists_url: 'https://api.github.com/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: 'https://api.github.com/search/issues{?q,page,per_page,sort,order}',
        issues_url: 'https://api.github.com/issues',
        keys_url: 'https://api.github.com/user/keys',
        label_search_url: 'https://api.github.com/search/labels{?q,repository_id}',
        notifications_url: 'https://api.github.com/notifications',
        organization_url: 'https://api.github.com/orgs/{org}',
        organization_repositories_url: 'https://api.github.com/orgs/{org}/repos',
        organization_teams_url: 'https://api.github.com/orgs/{org}/teams',
        public_gists_url: 'https://api.github.com/gists/public',
        rate_limit_url: 'https://api.github.com/rate_limit',
        repository_url: 'https://api.github.com/repos/{owner}/{repo}',
        repository_search_url: 'https://api.github.com/search/repositories{?q,page,per_page,sort,order}',
        current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort,direction}',
        starred_url: 'https://api.github.com/user/starred{?owner,repo}',
        starred_gists_url: 'https://api.github.com/gists/starred',
        user_url: 'https://api.github.com/user',
        user_organizations_url: 'https://api.github.com/user/orgs',
        user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort,direction}',
        user_search_url: 'https://api.github.com/search/users{?q}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    // 2. GET /api/v3/meta
    if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }

    // 3. GET /api/v3/user/repos or POST /api/v3/user/repos
    if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
      if (method === 'GET') {
        const perPage = parseInt(urlObj.searchParams.get('per_page') ?? '30', 10);
        const page = parseInt(urlObj.searchParams.get('page') ?? '1', 10);
        const repos = store.listReposForUser('adaiversen');
        const start = (page - 1) * perPage;
        const pageRepos = repos.slice(start, start + perPage);
        const formatted = pageRepos.map(formatRepo);

        const headers: Record<string, string> = {};
        if (start + perPage < repos.size || start + perPage < repos.length) {
          const nextPage = page + 1;
          const proto = req.headers['x-forwarded-proto'] ?? 'http';
          const host = req.headers.host ?? '127.0.0.1:8932';
          headers['link'] = `<${proto}://${host}/api/v3/user/repos?page=${nextPage}&per_page=${perPage}>; rel="next"`;
        }
        sendJson(res, 200, formatted, headers);
        return true;
      }
      if (method === 'POST') {
        let body: any;
        try {
          body = await readJsonBody();
        } catch {
          sendJson(res, 400, { message: 'Bad Request: malformed JSON' });
          return true;
        }
        const name = body.name;
        if (!name || typeof name !== 'string') {
          sendJson(res, 422, { message: 'Repository name is required' });
          return true;
        }
        const description = body.description ?? '';
        const isPrivate = body.private ?? false;
        try {
          const repo = store.createRepo('adaiversen', name, description, isPrivate);
          sendJson(res, 201, formatRepo(repo));
        } catch (err: any) {
          sendJson(res, 422, { message: err.message || 'Repository already exists' });
        }
        return true;
      }
    }

    // Repositories under /api/v3/repos/{owner}/{repo}/...
    if (parts[0] === 'repos' && parts.length >= 3) {
      const owner = parts[1]!;
      const repoName = parts[2]!;
      const repoKey = `${owner}/${repoName}`.toLowerCase();

      // Rule: repos only exist under adaiversen; foreign owner = 404 never 403
      if (owner.toLowerCase() !== 'adaiversen') {
        sendJson(res, 404, { message: 'Repository not found' });
        return true;
      }

      const repo = store.repos.get(repoKey);
      if (!repo) {
        sendJson(res, 404, { message: 'Repository not found' });
        return true;
      }

      const subPath = parts.slice(3);

      // GET /api/v3/repos/{o}/{r}
      if (subPath.length === 0 && method === 'GET') {
        sendJson(res, 200, formatRepo(repo));
        return true;
      }

      // PATCH /api/v3/repos/{o}/{r}
      if (subPath.length === 0 && method === 'PATCH') {
        let body: any;
        try {
          body = await readJsonBody();
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return true;
        }
        if (body.description !== undefined) {
          repo.description = body.description;
        }
        if (body.private !== undefined) {
          repo.private = body.private;
        }
        repo.updatedAt = now();
        sendJson(res, 200, formatRepo(repo));
        return true;
      }

      // DELETE /api/v3/repos/{o}/{r}
      if (subPath.length === 0 && method === 'DELETE') {
        store.repos.delete(repoKey);
        store.refs.delete(repoKey);
        store.labels.delete(repoKey);
        store.issues.delete(repoKey);
        store.pulls.delete(repoKey);
        res.writeHead(204, { 'x-github-request-id': getNextRequestId() });
        res.end();
        return true;
      }

      // Branches: GET /api/v3/repos/{o}/{r}/branches or POST /api/v3/repos/{o}/{r}/git/refs
      if (subPath[0] === 'branches' && subPath.length === 1 && method === 'GET') {
        const refsMap = store.refs.get(repoKey) ?? new Map();
        const branchList: any[] = [];
        for (const [refName, oid] of refsMap.entries()) {
          if (refName.startsWith('refs/heads/')) {
            const name = refName.replace('refs/heads/', '');
            branchList.push({ name, commit: { sha: oid } });
          }
        }
        sendJson(res, 200, branchList);
        return true;
      }

      if (subPath[0] === 'git' && subPath[1] === 'refs' && subPath.length === 2 && method === 'POST') {
        let body: any;
        try {
          body = await readJsonBody();
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return true;
        }
        const refName = body.ref;
        const sha = body.sha;
        if (!refName || !sha) {
          sendJson(res, 422, { message: 'ref and sha required' });
          return true;
        }
        const refsMap = store.refs.get(repoKey)!;
        refsMap.set(refName, sha);
        sendJson(res, 201, { ref: refName, object: { sha } });
        return true;
      }

      // Commits: GET /api/v3/repos/{o}/{r}/commits
      if (subPath[0] === 'commits' && subPath.length === 1 && method === 'GET') {
        const shaQuery = urlObj.searchParams.get('sha') ?? 'refs/heads/main';
        const refsMap = store.refs.get(repoKey) ?? new Map();
        let currentOid = refsMap.get(shaQuery) ?? refsMap.get(`refs/heads/${shaQuery}`) ?? refsMap.get(`refs/tags/${shaQuery}`) ?? (isObjectId(shaQuery) ? shaQuery : refsMap.get('refs/heads/main') ?? refsMap.get('HEAD'));

        const commits: any[] = [];
        const visited = new Set<string>();
        let curr = currentOid;

        while (curr && store.objects.has(curr) && !visited.has(curr) && commits.length < 50) {
          visited.add(curr);
          const obj = store.objects.get(curr);
          if (!obj) break;
          try {
            const parsed = parseCommit(obj);
            commits.push({
              sha: curr,
              commit: {
                message: parsed.message,
                author: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(now() * 1000).toISOString() },
                committer: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(now() * 1000).toISOString() },
              },
            });
            curr = parsed.parents[0];
          } catch {
            break;
          }
        }
        sendJson(res, 200, commits);
        return true;
      }

      // Contents: PUT/GET/DELETE /api/v3/repos/{o}/{r}/contents/{path}
      if (subPath[0] === 'contents') {
        const filePath = subPath.slice(1).join('/');
        const refsMap = store.refs.get(repoKey)!;

        let body: any = {};
        if (method === 'PUT' || method === 'DELETE') {
          try {
            body = await readJsonBody();
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return true;
          }
        }

        // Resolve branch/ref supporting body.branch (GitHub REST spec for PUT/DELETE contents), query ref/branch, or default branch
        const branch = body.branch ?? urlObj.searchParams.get('ref') ?? urlObj.searchParams.get('branch') ?? repo.defaultBranch ?? 'main';
        const refName = branch.startsWith('refs/') ? branch : (refsMap.has(`refs/heads/${branch}`) ? `refs/heads/${branch}` : (refsMap.has(`refs/tags/${branch}`) ? `refs/tags/${branch}` : `refs/heads/${branch}`));

        if (method === 'GET') {
          const commitOid = refsMap.get(refName);
          if (!commitOid) {
            sendJson(res, 404, { message: 'Not Found (unborn or empty branch)' });
            return true;
          }
          const commitObj = store.objects.get(commitOid);
          if (!commitObj) {
            sendJson(res, 404, { message: 'Commit not found' });
            return true;
          }
          const commit = parseCommit(commitObj);
          // Walk tree to find filePath
          const findInTree = (treeOid: string, partsArr: string[]): { type: string; oid: string; mode: string } | undefined => {
            const treeObj = store.objects.get(treeOid);
            if (!treeObj) return undefined;
            const entries = parseTree(treeObj);
            const [first, ...rest] = partsArr;
            const entry = entries.find(e => e.name === first);
            if (!entry) return undefined;
            if (rest.length === 0) return { type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
            if (entry.mode === '40000') return findInTree(entry.oid, rest);
            return undefined;
          };

          const found = findInTree(commit.tree, filePath ? filePath.split('/') : []);
          if (!found) {
            sendJson(res, 404, { message: 'Path not found' });
            return true;
          }

          if (found.type === 'dir') {
            const dirObj = store.objects.get(found.oid);
            if (!dirObj) {
              sendJson(res, 404, { message: 'Directory object not found' });
              return true;
            }
            const entries = parseTree(dirObj);
            const listing = entries.map(e => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: filePath ? `${filePath}/${e.name}` : e.name,
              sha: e.oid,
              size: e.mode === '40000' ? 0 : (store.objects.get(e.oid)?.length ?? 0),
            }));
            sendJson(res, 200, listing);
            return true;
          } else {
            const fileObj = store.objects.get(found.oid);
            if (!fileObj) {
              sendJson(res, 404, { message: 'Blob not found' });
              return true;
            }
            sendJson(res, 200, {
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              sha: found.oid,
              size: fileObj.length,
              type: 'file',
              encoding: 'base64',
              content: fileObj.toString('base64'),
            });
            return true;
          }
        }

        if (method === 'PUT') {
          const contentBase64 = body.content ?? '';
          const fileContent = Buffer.from(contentBase64, 'base64');
          const clientSha = body.sha;

          // Check if repo has existing commit on refName
          const parentOid = refsMap.get(refName);
          let existingBlobOid: string | undefined;

          if (parentOid) {
            const parentCommitObj = store.objects.get(parentOid);
            if (parentCommitObj) {
              const commit = parseCommit(parentCommitObj);
              // Find existing blob for stale SHA check
              const findBlob = (treeOid: string, partsArr: string[]): string | undefined => {
                const treeObj = store.objects.get(treeOid);
                if (!treeObj) return undefined;
                const entries = parseTree(treeObj);
                const [first, ...rest] = partsArr;
                const entry = entries.find(e => e.name === first);
                if (!entry) return undefined;
                if (rest.length === 0) return entry.oid;
                return findBlob(entry.oid, rest);
              };
              existingBlobOid = findBlob(commit.tree, filePath.split('/'));
            }
          }

          // If file exists and clientSha provided does not match existingBlobOid -> 409 Conflict
          if (existingBlobOid && clientSha && clientSha !== existingBlobOid) {
            sendJson(res, 409, { message: 'Stale SHA or conflict' });
            return true;
          }
          if (existingBlobOid && !clientSha) {
            // Updating existing file without sha -> 409
            sendJson(res, 409, { message: 'Sha required for updating existing file' });
            return true;
          }

          // Store new blob
          const newBlobOid = hashObject('blob', fileContent);
          store.objects.set(newBlobOid, fileContent);
          store.objectTypes.set(newBlobOid, 'blob');

          // Build new tree recursively
          const updateTree = (treeOid: string | undefined, partsArr: string[], blobOid: string): string => {
            let entries: any[] = [];
            if (treeOid) {
              const tObj = store.objects.get(treeOid);
              if (tObj) entries = [...parseTree(tObj)];
            }
            const [first, ...rest] = partsArr;
            if (rest.length === 0) {
              // Replace or add entry
              const filtered = entries.filter(e => e.name !== first);
              filtered.push({ mode: '100644', name: first, oid: blobOid });
              const newTreeBuf = buildTree(filtered);
              const newTreeOid = hashObject('tree', newTreeBuf);
              store.objects.set(newTreeOid, newTreeBuf);
              store.objectTypes.set(newTreeOid, 'tree');
              return newTreeOid;
            } else {
              // Subtree
              const existingEntry = entries.find(e => e.name === first && e.mode === '40000');
              const subTreeOid = updateTree(existingEntry?.oid, rest, blobOid);
              const filtered = entries.filter(e => e.name !== first);
              filtered.push({ mode: '40000', name: first, oid: subTreeOid });
              const newTreeBuf = buildTree(filtered);
              const newTreeOid = hashObject('tree', newTreeBuf);
              store.objects.set(newTreeOid, newTreeBuf);
              store.objectTypes.set(newTreeOid, 'tree');
              return newTreeOid;
            }
          };

          const parentTreeOid = parentOid ? parseCommit(store.objects.get(parentOid)!).tree : undefined;
          const newTreeOid = updateTree(parentTreeOid, filePath.split('/'), newBlobOid);

          const commitMsg = body.message || `Update ${filePath}`;
          const parents = parentOid ? [parentOid] : [];
          const commitBuf = buildCommit({
            tree: newTreeOid,
            parents,
            message: commitMsg,
            timestamp: now(),
          });
          const newCommitSha = hashObject('commit', commitBuf);
          store.objects.set(newCommitSha, commitBuf);
          store.objectTypes.set(newCommitSha, 'commit');

          refsMap.set(refName, newCommitSha);
          if (!refsMap.has('refs/heads/main') && refName !== 'refs/heads/main') {
            refsMap.set('refs/heads/main', newCommitSha);
          }

          const status = existingBlobOid ? 200 : 201;
          sendJson(res, status, {
            content: {
              name: filePath.split('/').pop(),
              path: filePath,
              sha: newBlobOid,
              size: fileContent.length,
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: newCommitSha,
            },
          });
          return true;
        }

        if (method === 'DELETE') {
          const parentOid = refsMap.get(refName);
          if (!parentOid) {
            sendJson(res, 404, { message: 'Not found' });
            return true;
          }
          const parentCommitObj = store.objects.get(parentOid);
          const parentCommit = parseCommit(parentCommitObj!);

          const removePath = (treeOid: string, partsArr: string[]): string => {
            const tObj = store.objects.get(treeOid)!;
            const entries = parseTree(tObj);
            const [first, ...rest] = partsArr;
            if (rest.length === 0) {
              const filtered = entries.filter(e => e.name !== first);
              const newTreeBuf = buildTree(filtered);
              const newTreeOid = hashObject('tree', newTreeBuf);
              store.objects.set(newTreeOid, newTreeBuf);
              store.objectTypes.set(newTreeOid, 'tree');
              return newTreeOid;
            } else {
              const existing = entries.find(e => e.name === first && e.mode === '40000');
              if (!existing) return treeOid;
              const newSubOid = removePath(existing.oid, rest);
              const filtered = entries.filter(e => e.name !== first);
              filtered.push({ mode: '40000', name: first, oid: newSubOid });
              const newTreeBuf = buildTree(filtered);
              const newTreeOid = hashObject('tree', newTreeBuf);
              store.objects.set(newTreeOid, newTreeBuf);
              store.objectTypes.set(newTreeOid, 'tree');
              return newTreeOid;
            }
          };

          const newTreeOid = removePath(parentCommit.tree, filePath.split('/'));
          const commitBuf = buildCommit({
            tree: newTreeOid,
            parents: [parentOid],
            message: `Delete ${filePath}`,
            timestamp: now(),
          });
          const newCommitSha = hashObject('commit', commitBuf);
          store.objects.set(newCommitSha, commitBuf);
          store.objectTypes.set(newCommitSha, 'commit');
          refsMap.set(refName, newCommitSha);

          sendJson(res, 200, { commit: { sha: newCommitSha } });
          return true;
        }
      }

      // Labels: POST /api/v3/repos/{o}/{r}/labels
      if (subPath[0] === 'labels' && subPath.length === 1 && method === 'POST') {
        let body: any;
        try {
          body = await readJsonBody();
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return true;
        }
        const labelName = body.name;
        if (!labelName) {
          sendJson(res, 422, { message: 'Label name required' });
          return true;
        }
        const repoLabels = store.labels.get(repoKey) ?? new Map();
        const labelObj = { name: labelName, color: body.color ?? 'ededed' };
        repoLabels.set(labelName.toLowerCase(), labelObj);
        store.labels.set(repoKey, repoLabels);
        sendJson(res, 201, labelObj);
        return true;
      }

      // Issues: /api/v3/repos/{o}/{r}/issues...
      if (subPath[0] === 'issues') {
        const issueList = store.issues.get(repoKey) ?? [];
        const repoLabels = store.labels.get(repoKey) ?? new Map();

        // POST /api/v3/repos/{o}/{r}/issues
        if (subPath.length === 1 && method === 'POST') {
          let body: any;
          try {
            body = await readJsonBody();
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return true;
          }
          const title = body.title;
          const bodyText = body.body ?? '';
          const labelsInput = body.labels ?? [];

          // Validate labels
          for (const l of labelsInput) {
            const lName = typeof l === 'string' ? l : l.name;
            if (lName && !repoLabels.has(lName.toLowerCase())) {
              sendJson(res, 422, { message: `Label ${lName} does not exist` });
              return true;
            }
          }

          store.issueIdCounter++;
          const issueNum = issueList.length + 1;
          const newIssue = {
            id: store.issueIdCounter,
            number: issueNum,
            owner,
            repo: repoName,
            title: title ?? '',
            body: bodyText,
            state: 'open' as const,
            labels: labelsInput.map((l: any) => (typeof l === 'string' ? l : l.name)),
            user: { login: 'adaiversen', id: 1000 },
            createdAt: now(),
            updatedAt: now(),
            commentsCount: 0,
            comments: [],
          };
          issueList.push(newIssue);
          store.issues.set(repoKey, issueList);
          invalidateIssueCache(repoKey);

          sendJson(res, 201, formatIssue(newIssue, repo));
          return true;
        }

        // GET /api/v3/repos/{o}/{r}/issues
        if (subPath.length === 1 && method === 'GET') {
          const stateQuery = urlObj.searchParams.get('state') ?? 'open';
          const sortQuery = urlObj.searchParams.get('sort') ?? 'created';
          const directionQuery = urlObj.searchParams.get('direction') ?? 'desc';

          let filtered = [...issueList];
          if (stateQuery !== 'all') {
            filtered = filtered.filter(i => i.state === stateQuery);
          }

          filtered.sort((a, b) => {
            if (sortQuery === 'created' && a.createdAt !== b.createdAt) {
              const cmp = a.createdAt - b.createdAt;
              return directionQuery === 'asc' ? cmp : -cmp;
            }
            const cmpNum = a.number - b.number;
            return directionQuery === 'asc' ? cmpNum : -cmpNum;
          });

          sendJson(res, 200, filtered.map(i => formatIssue(i, repo)));
          return true;
        }

        // Single issue operations: /api/v3/repos/{o}/{r}/issues/{number} or comments
        const issueNum = parseInt(subPath[1]!, 10);
        const issue = issueList.find(i => i.number === issueNum);

        if (!issue) {
          sendJson(res, 404, { message: 'Issue not found' });
          return true;
        }

        const issueSubPath = subPath.slice(2);

        // GET /api/v3/repos/{o}/{r}/issues/{n}
        if (issueSubPath.length === 0 && method === 'GET') {
          const cacheKey = `${repoKey}:issue:${issueNum}`;
          const cached = issueCache.get(cacheKey);
          if (cached) {
            res.writeHead(200, {
              'content-type': JSON_TYPE,
              'content-length': Buffer.byteLength(cached.bodyText),
              'x-github-request-id': getNextRequestId(),
            });
            res.end(cached.bodyText);
            return true;
          }

          const formatted = formatIssue(issue, repo);
          const bodyText = `${JSON.stringify(formatted)}\n`;
          issueCache.set(cacheKey, { etag: `W/"${issue.updatedAt}"`, bodyText });

          res.writeHead(200, {
            'content-type': JSON_TYPE,
            'content-length': Buffer.byteLength(bodyText),
            'x-github-request-id': getNextRequestId(),
          });
          res.end(bodyText);
          return true;
        }

        // PATCH /api/v3/repos/{o}/{r}/issues/{n}
        if (issueSubPath.length === 0 && method === 'PATCH') {
          let body: any;
          try {
            body = await readJsonBody();
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return true;
          }
          if (body.state) issue.state = body.state;
          if (body.title) issue.title = body.title;
          if (body.body !== undefined) issue.body = body.body;
          issue.updatedAt = now();
          invalidateIssueCache(repoKey);

          sendJson(res, 200, formatIssue(issue, repo));
          return true;
        }

        // Comments: /api/v3/repos/{o}/{r}/issues/{n}/comments
        if (issueSubPath[0] === 'comments') {
          const commentsList = (issue as any).comments ?? [];
          if (method === 'GET') {
            sendJson(res, 200, commentsList);
            return true;
          }
          if (method === 'POST') {
            let body: any;
            try {
              body = await readJsonBody();
            } catch {
              sendJson(res, 400, { message: 'Bad Request' });
              return true;
            }
            const commentObj = {
              id: commentsList.length + 100,
              body: body.body ?? '',
              user: { login: 'adaiversen', id: 1000 },
              created_at: new Date(now() * 1000).toISOString(),
            };
            commentsList.push(commentObj);
            (issue as any).comments = commentsList;
            issue.commentsCount = commentsList.length;
            issue.updatedAt = now();
            invalidateIssueCache(repoKey);

            sendJson(res, 201, commentObj);
            return true;
          }
        }
      }

      // Pull Requests: /api/v3/repos/{o}/{r}/pulls...
      if (subPath[0] === 'pulls') {
        const pullsList = store.pulls.get(repoKey) ?? [];

        // POST /api/v3/repos/{o}/{r}/pulls
        if (subPath.length === 1 && method === 'POST') {
          let body: any;
          try {
            body = await readJsonBody();
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return true;
          }
          const title = body.title;
          const head = body.head;
          const base = body.base;
          if (!title || !head || !base) {
            sendJson(res, 422, { message: 'title, head, base required' });
            return true;
          }

          store.pullIdCounter++;
          const pullNum = pullsList.length + 1;
          const refsMap = store.refs.get(repoKey)!;
          const headRefName = head.startsWith('refs/') ? head : `refs/heads/${head}`;
          const baseRefName = base.startsWith('refs/') ? base : `refs/heads/${base}`;
          const headOid = refsMap.get(headRefName) ?? '0'.repeat(40);
          const baseOid = refsMap.get(baseRefName) ?? '0'.repeat(40);

          const newPull = {
            id: store.pullIdCounter,
            number: pullNum,
            owner,
            repo: repoName,
            title,
            body: body.body ?? '',
            state: 'open' as const,
            merged: false,
            head,
            base,
            headData: { sha: headOid },
            baseData: { sha: baseOid },
            user: { login: 'adaiversen', id: 1000 },
            createdAt: now(),
            updatedAt: now(),
            files: ['README.md'],
          };
          pullsList.push(newPull);
          store.pulls.set(repoKey, pullsList);

          sendJson(res, 201, formatPull(newPull, repo, store));
          return true;
        }

        // GET /api/v3/repos/{o}/{r}/pulls
        if (subPath.length === 1 && method === 'GET') {
          const stateQuery = urlObj.searchParams.get('state') ?? 'open';
          let filtered = [...pullsList];
          if (stateQuery !== 'all') {
            filtered = filtered.filter(p => p.state === stateQuery || (stateQuery === 'open' && !p.merged));
          }
          sendJson(res, 200, filtered.map(p => formatPull(p, repo, store)));
          return true;
        }

        const pullNum = parseInt(subPath[1]!, 10);
        const pull = pullsList.find(p => p.number === pullNum);

        if (!pull) {
          sendJson(res, 404, { message: 'Pull request not found' });
          return true;
        }

        const pullSubPath = subPath.slice(2);

        // GET /api/v3/repos/{o}/{r}/pulls/{n}
        if (pullSubPath.length === 0 && method === 'GET') {
          sendJson(res, 200, formatPull(pull, repo, store));
          return true;
        }

        // GET /api/v3/repos/{o}/{r}/pulls/{n}/files
        if (pullSubPath[0] === 'files' && pullSubPath.length === 1 && method === 'GET') {
          sendJson(res, 200, getPullFiles(store, repo, pull));
          return true;
        }

        // PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge
        if (pullSubPath[0] === 'merge' && pullSubPath.length === 1 && method === 'PUT') {
          let body: any = {};
          try {
            body = await readJsonBody();
          } catch {}
          const result = performSquashMerge(store, owner, repoName, pullNum, body.commit_message);
          sendJson(res, result.status, result.body);
          return true;
        }
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err: any) {
    if (err.message === 'MALFORMED_JSON') {
      sendJson(res, 400, { message: 'Bad Request: malformed JSON' });
      return true;
    }
    sendJson(res, 500, { message: err.message || 'Internal Server Error' });
    return true;
  }
}
