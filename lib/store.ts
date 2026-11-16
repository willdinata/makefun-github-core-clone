import { buildScenario, type Scenario, type ScenarioUser, type ScenarioRepo, SCENARIO_EPOCH_SEC } from './wire.ts';

export function now(): number {
  const envNow = process.env.MAKEFUN_TRIAL_NOW;
  if (envNow !== undefined && envNow !== '') {
    const parsed = Number(envNow);
    if (Number.isFinite(parsed)) return parsed;
  }
  return SCENARIO_EPOCH_SEC;
}

export interface StoredRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredIssue {
  id: number;
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: ScenarioUser;
  createdAt: number;
  updatedAt: number;
  commentsCount: number;
}

export interface StoredPullRequest {
  id: number;
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha?: string;
  head: string;
  base: string;
  user: ScenarioUser;
  createdAt: number;
  updatedAt: number;
  files: string[];
}

export interface StoredLabel {
  name: string;
  color?: string;
}

export class MemoryStore {
  scenario: Scenario;
  users: Map<string, ScenarioUser> = new Map();
  repos: Map<string, StoredRepo> = new Map(); // key: owner/repo
  refs: Map<string, Map<string, string>> = new Map(); // key: owner/repo -> refName -> oid
  objects: Map<string, Buffer> = new Map(); // key: oid -> raw object buffer
  labels: Map<string, Map<string, StoredLabel>> = new Map(); // key: owner/repo -> labelName -> StoredLabel
  issues: Map<string, StoredIssue[]> = new Map(); // key: owner/repo -> issues
  pulls: Map<string, StoredPullRequest[]> = new Map(); // key: owner/repo -> pulls
  
  repoIdCounter = 10000;
  issueIdCounter = 1000;
  pullIdCounter = 1000;

  constructor() {
    this.scenario = buildScenario();
    this.initFromScenario();
  }

  private initFromScenario() {
    // Populate users
    for (const u of this.scenario.users) {
      this.users.set(u.login.toLowerCase(), u);
    }

    // Populate repos, labels, issues, pulls
    const allRepos = [...this.scenario.repos, ...this.scenario.orgRepos, ...this.scenario.strangerRepos];
    for (const r of allRepos) {
      const key = r.fullName.toLowerCase();
      this.repos.set(key, {
        id: r.id,
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
        description: r.description,
        private: r.private,
        defaultBranch: r.defaultBranch,
        createdAt: now(),
        updatedAt: now(),
      });

      // Labels
      const repoLabels = new Map<string, StoredLabel>();
      for (const lblName of this.scenario.labels) {
        repoLabels.set(lblName.toLowerCase(), { name: lblName });
      }
      this.labels.set(key, repoLabels);

      // Refs
      const repoRefs = new Map<string, string>();
      // We can seed a dummy HEAD and main ref if needed or git-client creates them on push/clone
      this.refs.set(key, repoRefs);

      // Issues
      const repoIssues: StoredIssue[] = [];
      for (let i = 0; i < this.scenario.issues.length; i++) {
        const iss = this.scenario.issues[i];
        if (iss) {
          this.issueIdCounter++;
          repoIssues.push({
            id: this.issueIdCounter,
            number: i + 1,
            owner: r.owner,
            repo: r.name,
            title: iss.title,
            body: iss.body,
            state: 'open',
            labels: [...iss.labels],
            user: this.scenario.viewer,
            createdAt: now(),
            updatedAt: now(),
            commentsCount: 0,
          });
        }
      }
      this.issues.set(key, repoIssues);

      // Pulls
      const repoPulls: StoredPullRequest[] = [];
      for (let i = 0; i < this.scenario.pulls.length; i++) {
        const pr = this.scenario.pulls[i];
        if (pr) {
          this.pullIdCounter++;
          repoPulls.push({
            id: this.pullIdCounter,
            number: i + 1,
            owner: r.owner,
            repo: r.name,
            title: pr.title,
            body: pr.body,
            state: 'open',
            merged: false,
            head: pr.head,
            base: pr.base,
            user: this.scenario.viewer,
            createdAt: now(),
            updatedAt: now(),
            files: [...this.scenario.filePaths.slice(0, 3)],
          });
        }
      }
      this.pulls.set(key, repoPulls);
    }
  }

  getRepo(owner: string, name: string): StoredRepo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  listReposForUser(login: string): StoredRepo[] {
    const out: StoredRepo[] = [];
    const l = login.toLowerCase();
    for (const r of this.repos.values()) {
      if (r.owner.toLowerCase() === l) {
        out.push(r);
      }
    }
    return out.sort((a, b) => b.id - a.id);
  }

  createRepo(owner: string, name: string, description: string = '', isPrivate: boolean = false): StoredRepo {
    const fullName = `${owner}/${name}`;
    const key = fullName.toLowerCase();
    if (this.repos.has(key)) {
      throw new Error(`Repository ${fullName} already exists`);
    }
    this.repoIdCounter++;
    const repo: StoredRepo = {
      id: this.repoIdCounter,
      owner,
      name,
      fullName,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now(),
      updatedAt: now(),
    };
    this.repos.set(key, repo);
    this.refs.set(key, new Map());
    this.labels.set(key, new Map());
    this.issues.set(key, []);
    this.pulls.set(key, []);
    return repo;
  }
}

export const globalStore = new MemoryStore();
