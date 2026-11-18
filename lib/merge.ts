import { MemoryStore } from './store.ts';
import { parseCommit, buildCommit, hashObject, deflateLoose, getFilesFromTree } from './gitobj.ts';
import { now } from './store.ts';

export function performSquashMerge(
  store: MemoryStore,
  owner: string,
  repoName: string,
  pullNumber: number,
  commitMessage?: string
): { status: number; body: any } {
  const repoKey = `${owner}/${repoName}`.toLowerCase();
  const repo = store.repos.get(repoKey);
  if (!repo) {
    return { status: 404, body: { message: 'Repository not found' } };
  }

  const pulls = store.pulls.get(repoKey) ?? [];
  const pr = pulls.find(p => p.number === pullNumber);
  if (!pr) {
    return { status: 404, body: { message: 'Pull request not found' } };
  }

  if (pr.merged || pr.state === 'closed') {
    return { status: 405, body: { message: 'Pull request already merged or closed' } };
  }

  const refsMap = store.refs.get(repoKey);
  if (!refsMap) {
    return { status: 405, body: { message: 'Repository refs missing' } };
  }

  const headRefName = pr.head.startsWith('refs/') ? pr.head : `refs/heads/${pr.head}`;
  const baseRefName = pr.base.startsWith('refs/') ? pr.base : `refs/heads/${pr.base}`;

  let headOid = refsMap.get(headRefName);
  if (!headOid && pr.headData?.sha) {
    headOid = pr.headData.sha;
  }
  if (!headOid) {
    return { status: 405, body: { message: `Head ref ${headRefName} not found` } };
  }

  const headCommitObj = store.objects.get(headOid);
  if (!headCommitObj) {
    return { status: 405, body: { message: `Head commit object ${headOid} not found` } };
  }

  const headCommit = parseCommit(headCommitObj);
  const baseOid = refsMap.get(baseRefName) ?? refsMap.get('refs/heads/main');

  if (baseOid && headOid) {
    // 3-way conflict check
    const baseAncestors = new Set<string>();
    const queue = [baseOid];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (baseAncestors.has(curr)) continue;
      baseAncestors.add(curr);
      const obj = store.objects.get(curr);
      if (!obj) continue;
      try {
        const commit = parseCommit(obj);
        for (const p of commit.parents) {
          if (!baseAncestors.has(p)) queue.push(p);
        }
      } catch {}
    }

    let mergeBaseOid: string | undefined = undefined;
    const headQueue = [headOid];
    const headVisited = new Set<string>();
    while (headQueue.length > 0) {
      const curr = headQueue.shift()!;
      if (baseAncestors.has(curr)) {
        mergeBaseOid = curr;
        break;
      }
      if (headVisited.has(curr)) continue;
      headVisited.add(curr);
      const obj = store.objects.get(curr);
      if (!obj) continue;
      try {
        const commit = parseCommit(obj);
        for (const p of commit.parents) {
          if (!headVisited.has(p)) headQueue.push(p);
        }
      } catch {}
    }

    if (mergeBaseOid) {
      const mbCommit = parseCommit(store.objects.get(mergeBaseOid)!);
      const baseCommit = parseCommit(store.objects.get(baseOid)!);

      const mbFiles = getFilesFromTree(store, mbCommit.tree);
      const baseFiles = getFilesFromTree(store, baseCommit.tree);
      const headFiles = getFilesFromTree(store, headCommit.tree);

      const allPaths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
      for (const path of allPaths) {
        const mbOid = mbFiles.get(path);
        const baseFileOid = baseFiles.get(path);
        const headFileOid = headFiles.get(path);

        const baseChanged = baseFileOid !== mbOid;
        const headChanged = headFileOid !== mbOid;

        if (baseChanged && headChanged && baseFileOid !== headFileOid) {
          return {
            status: 405,
            body: { message: `Merge conflict in ${path}` },
          };
        }
      }
    }
  }

  const parents = baseOid ? [baseOid] : [];
  const message = commitMessage || `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;

  const commitBuf = buildCommit({
    tree: headCommit.tree,
    parents,
    message,
    timestamp: now(),
  });

  const newCommitSha = hashObject('commit', commitBuf);
  store.objects.set(newCommitSha, commitBuf);
  store.objectTypes.set(newCommitSha, 'commit');

  // Update base branch ref
  refsMap.set(baseRefName, newCommitSha);
  if (!refsMap.has('refs/heads/main') && baseRefName !== 'refs/heads/main') {
    refsMap.set('refs/heads/main', newCommitSha);
  }

  // Update PR state
  pr.merged = true;
  pr.state = 'closed';
  pr.mergeCommitSha = newCommitSha;
  pr.updatedAt = now();
  (pr as any).merged_at = new Date(now() * 1000).toISOString();

  return {
    status: 200,
    body: {
      sha: newCommitSha,
      merged: true,
      message: 'Pull request successfully merged',
    },
  };
}
