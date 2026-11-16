// store.ts — the forge's own store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Everything lives in memory; the store is
// deterministic (a counter clock, never the wall clock) so two runs on the same
// requests reach the same object ids.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';
import { forgeIdentity, viewerIdentity, type ViewerIdentity } from './scenario.ts';

export interface LabelRecord {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: string;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: CommentRecord[];
}

export interface PullRecord {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  readonly user: string;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: IssueRecord[];
  readonly pulls: PullRecord[];
  nextNumber: number;
  readonly createdAt: string;
  updatedAt: string;
}

/** One changed path between two trees, with line counts for the files view. */
export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

const CLOCK_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one

export class Store {
  readonly viewer: ViewerIdentity;
  readonly identity: string;
  private readonly repos = new Map<string, Repo>();
  private readonly repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private nextSeq = 1;
  private clock = 0;

  constructor() {
    this.viewer = viewerIdentity();
    this.identity = forgeIdentity(this.viewer);
  }

  /** A deterministic, strictly increasing timestamp (seconds, then ISO). */
  private tick(): { sec: number; iso: string } {
    this.clock += 1;
    const sec = CLOCK_EPOCH_SEC + this.clock;
    return { sec, iso: new Date(sec * 1000).toISOString() };
  }

  nowIso(): string {
    return this.tick().iso;
  }

  /** Monotonic id source shared by issues, pull requests and comments. */
  allocateId(): number {
    return this.nextGlobalId++;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const stamp = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
    };
    this.repos.set(this.key(owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return this.repoList.filter((repo) => repo.owner === owner);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    return true;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a branch name, full ref, or commit sha to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** The tip commit of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Flatten a commit's tree into path -> {mode, oid} (blobs only, plus subtree modes). */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        out.set(path, { mode: entry.mode, oid: entry.oid });
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      if (entry.mode === '40000') continue; // directories are rebuilt from files
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Commit file changes on a branch. `changes` maps a path to new bytes (null deletes
   * it). A missing branch is created from the default branch's tip (or as the first
   * commit when the repository is unborn). Returns the new commit and, for a single
   * file change, its blob oid.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): { commitSha: string; blobOid: string | null } {
    const stamp = this.tick();
    let parent: string | null = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (parent === null && branch !== repo.defaultBranch) {
      parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const flat = new Map<string, { mode: string; oid: string }>();
    if (parent !== null) {
      const parentCommit = parseCommit((repo.objects.get(parent) as GitObject).data);
      this.flattenTree(repo, parentCommit.tree, '', flat);
    }
    let blobOid: string | null = null;
    for (const [path, content] of changes) {
      if (content === null) {
        flat.delete(path);
        // drop now-empty ancestor directory entries (they are rebuilt anyway)
        for (const key of [...flat.keys()]) {
          if (key.startsWith(`${path}/`)) flat.delete(key);
        }
      } else {
        blobOid = this.putObject(repo, 'blob', content);
        flat.set(path, { mode: '100644', oid: blobOid });
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity,
      committer: this.identity,
      timestamp: stamp.sec,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = stamp.iso;
    return { commitSha, blobOid };
  }

  /** Delete a file on a branch; null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return null;
    const flat = this.flattenTree(repo, parseCommit((repo.objects.get(tip) as GitObject).data).tree);
    if (!flat.has(path)) return null;
    return this.commitFiles(repo, branch, new Map([[path, null]]), message).commitSha;
  }

  /** The commits reachable from a tip, newest first (by author timestamp, then order). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> = [];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const authorStamp = Number((commit.author.match(/ (\d+) [+-]\d{4}$/) ?? [])[1] ?? 0);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, timestamp: authorStamp });
      for (const parent of commit.parents) queue.push(parent);
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }

  /** The peeled commit a ref points at (tags peel to their target commit). */
  peelRef(repo: Repo, oid: string): string {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** The object ids reachable from a set of tips (missing objects throw). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => repo.objects.get(oid));
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): LabelRecord {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: LabelRecord = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRecord | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
    }
    const stamp = this.tick();
    const issue: IssueRecord = {
      id: this.nextGlobalId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewer.login,
      seq: this.nextSeq++,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): IssueRecord | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  getPull(repo: Repo, number: number): PullRecord | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Issues and pull requests together, in creation order (GitHub's /issues view). */
  listIssuesAndPulls(repo: Repo): Array<IssueRecord | PullRecord> {
    const all: Array<IssueRecord | PullRecord> = [...repo.issues, ...repo.pulls];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRecord | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return { error: `Head branch '${head}' does not exist` };
    if (!baseSha) return { error: `Base branch '${base}' does not exist` };
    const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
    if (existing) return { error: 'A pull request already exists for this head and base' };
    const stamp = this.tick();
    const pull: PullRecord = {
      id: this.nextGlobalId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: true,
      user: this.viewer.login,
      seq: this.nextSeq++,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
    };
    pull.mergeable = !this.pullConflicts(repo, pull);
    repo.pulls.push(pull);
    return pull;
  }

  /** The diff between the merge-base tree and the head tree. */
  pullFiles(repo: Repo, pull: PullRecord): FileChange[] {
    const headCommit = parseCommit((repo.objects.get(pull.headSha) as GitObject).data);
    const baseCommit = parseCommit((repo.objects.get(pull.baseSha) as GitObject).data);
    const mergeBaseOid = mergeBase(pull.headSha, pull.baseSha, (oid) => repo.objects.get(oid));
    const baseTree = mergeBaseOid === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, parseCommit((repo.objects.get(mergeBaseOid) as GitObject).data).tree);
    void baseCommit;
    const headTree = this.flattenTree(repo, headCommit.tree);
    return diffTrees(repo, baseTree, headTree);
  }

  /** True when the pull request cannot merge cleanly onto its base tip. */
  pullConflicts(repo: Repo, pull: PullRecord): boolean {
    const mergeBaseOid = mergeBase(pull.headSha, pull.baseSha, (oid) => repo.objects.get(oid));
    const baseTree = mergeBaseOid === null
      ? new Map<string, { mode: string; oid: string }>()
      : this.flattenTree(repo, parseCommit((repo.objects.get(mergeBaseOid) as GitObject).data).tree);
    const headTree = this.flattenTree(repo, parseCommit((repo.objects.get(pull.headSha) as GitObject).data).tree);
    const baseTipTree = this.flattenTree(repo, parseCommit((repo.objects.get(pull.baseSha) as GitObject).data).tree);
    const headChanges = new Set(diffTrees(repo, baseTree, headTree).map((change) => change.filename));
    for (const path of headChanges) {
      const atBase = baseTree.get(path);
      const atTip = baseTipTree.get(path);
      const atHead = headTree.get(path);
      const baseChanged = (atBase?.oid ?? null) !== (atTip?.oid ?? null);
      const headChanged = (atBase?.oid ?? null) !== (atHead?.oid ?? null);
      if (baseChanged && headChanged && (atTip?.oid ?? null) !== (atHead?.oid ?? null)) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha,
   * or an error string ('conflict' | 'already-merged').
   */
  mergePull(repo: Repo, pull: PullRecord, method: string): string | { error: string } {
    if (pull.merged || pull.state !== 'open') return { error: 'already-merged' };
    // Refresh the head/base tips (branches may have moved since the PR opened).
    pull.headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    pull.baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    if (this.pullConflicts(repo, pull)) {
      pull.mergeable = false;
      return { error: 'conflict' };
    }
    const stamp = this.tick();
    const mergeBaseOid = mergeBase(pull.headSha, pull.baseSha, (oid) => repo.objects.get(oid));
    const baseTree = mergeBaseOid === null
      ? new Map<string, { mode: string; oid: string }>()
      : this.flattenTree(repo, parseCommit((repo.objects.get(mergeBaseOid) as GitObject).data).tree);
    const headTree = this.flattenTree(repo, parseCommit((repo.objects.get(pull.headSha) as GitObject).data).tree);
    const baseTipTree = this.flattenTree(repo, parseCommit((repo.objects.get(pull.baseSha) as GitObject).data).tree);
    // Apply the head's changes onto the base tip's tree.
    const merged = new Map(baseTipTree);
    for (const change of diffTrees(repo, baseTree, headTree)) {
      if (change.status === 'removed') merged.delete(change.filename);
      else {
        const entry = headTree.get(change.filename);
        if (entry) merged.set(change.filename, entry);
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const parents = method === 'merge' ? [pull.baseSha, pull.headSha] : [pull.baseSha];
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: this.identity,
      committer: this.identity,
      timestamp: stamp.sec,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp.iso;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = stamp.iso;
    pull.baseSha = mergeSha;
    repo.updatedAt = stamp.iso;
    return mergeSha;
  }

  // ------------------------------------------------------------ misc

  isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, (oid) => repo.objects.get(oid));
  }
}

/** Line counts of a blob, for the files view (a trailing newline ends the last line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** The changed paths between two flattened trees, sorted by filename. */
export function diffTrees(
  repo: Repo,
  oldTree: Map<string, { mode: string; oid: string }>,
  newTree: Map<string, { mode: string; oid: string }>,
): FileChange[] {
  const names = new Set([...oldTree.keys(), ...newTree.keys()]);
  const changes: FileChange[] = [];
  for (const name of [...names].sort()) {
    const oldEntry = oldTree.get(name);
    const newEntry = newTree.get(name);
    if (oldEntry?.mode === '40000' || newEntry?.mode === '40000') continue; // directories are not files
    if (oldEntry && newEntry) {
      if (oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) continue;
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(newData);
      const deletions = lineCount(oldData);
      changes.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
    } else if (newEntry) {
      const newData = repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(newData);
      changes.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const deletions = lineCount(oldData);
      changes.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: oldEntry.oid, newOid: null });
    }
  }
  return changes;
}
