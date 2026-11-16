import { type GitObjectType } from './gitobj.ts';

export const SCENARIO_EPOCH_SEC = 1_735_689_600;

export function now(): number {
  const envNow = process.env.MAKEFUN_TRIAL_NOW;
  if (envNow !== undefined && envNow !== '') {
    const parsed = Number(envNow);
    if (Number.isFinite(parsed)) return parsed;
    const dateParsed = Date.parse(envNow);
    if (Number.isFinite(dateParsed)) return Math.floor(dateParsed / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const USERS: readonly ScenarioUser[] = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
];

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
  users: Map<string, ScenarioUser> = new Map();
  repos: Map<string, StoredRepo> = new Map(); // key: owner/repo
  refs: Map<string, Map<string, string>> = new Map(); // key: owner/repo -> refName -> oid
  objects: Map<string, Buffer> = new Map(); // key: oid -> raw object buffer
  objectTypes: Map<string, GitObjectType> = new Map(); // key: oid -> object type
  labels: Map<string, Map<string, StoredLabel>> = new Map(); // key: owner/repo -> labelName -> StoredLabel
  issues: Map<string, StoredIssue[]> = new Map(); // key: owner/repo -> issues
  pulls: Map<string, StoredPullRequest[]> = new Map(); // key: owner/repo -> pulls
  
  repoIdCounter = 10000;
  issueIdCounter = 1000;
  pullIdCounter = 1000;

  constructor() {
    for (const u of USERS) {
      this.users.set(u.login.toLowerCase(), u);
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
