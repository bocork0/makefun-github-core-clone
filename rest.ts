// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, with GitHub's statuses, shapes and
// pagination headers.

import { parseCommit, parseTree } from './gitproto.ts';
import type { IssueRecord, PullRecord, Repo, Store } from './store.ts';
import { diffTrees } from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown; // object/array to JSON-encode, or null for an empty body
  readonly headers?: Readonly<Record<string, string>>;
}

function ok(body: unknown, headers?: Readonly<Record<string, string>>): RestResult {
  return { status: 200, body, headers };
}
function created(body: unknown): RestResult {
  return { status: 201, body };
}
function noContent(): RestResult {
  return { status: 204, body: null };
}
function failure(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const notFound = (): RestResult => failure(404, 'Not Found');
const unprocessable = (message: string): RestResult => failure(422, message);

/** An opaque Relay-style global id: base64 of `Type:key`, never the plain number. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

interface Ctx {
  store: Store;
  origin: string; // http://host:port, for Link headers and url fields
}

function userJson(ctx: Ctx): Record<string, unknown> {
  const viewer = ctx.store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: globalId('User', String(viewer.id)),
    avatar_url: `${ctx.origin}/avatars/${viewer.login}`,
    gravatar_id: '',
    url: `${ctx.origin}/api/v3/users/${viewer.login}`,
    html_url: `${ctx.origin}/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
  };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ctx.store.viewer.id, node_id: globalId('User', String(ctx.store.viewer.id)), type: 'User' },
    private: repo.private,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://${ctx.origin.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(ctx: Ctx, repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const names = [...repo.labels.keys()];
  return {
    id: names.indexOf(name) + 1,
    node_id: globalId('Label', `${repo.id}:${name}`),
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? '',
  };
}

function issueJson(ctx: Ctx, repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, id: ctx.store.viewer.id, type: 'User' },
    labels: issue.labels.map((name) => labelJson(ctx, repo, name)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: PullRecord): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const branchJson = (branch: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    user: { login: repo.owner, id: ctx.store.viewer.id, type: 'User' },
    repo: repoJson(ctx, repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.user, id: ctx.store.viewer.id, type: 'User' },
    labels: [],
    head: branchJson(pull.head, headSha),
    base: branchJson(pull.base, baseSha),
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(ctx: Ctx, repo: Repo, issueNumber: number, comment: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`),
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.user, id: ctx.store.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** Pagination: page/per_page from the query, and a GitHub Link header. */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, origin: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (items.length > perPage) {
    const links: string[] = [];
    const urlFor = (page: number): string => {
      const params = new URLSearchParams(query);
      params.set('per_page', String(perPage));
      params.set('page', String(page));
      return `${origin}${basePath}?${params.toString()}`;
    };
    if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
    if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
    headers.link = links.join(', ');
  }
  return { page, headers };
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Look a repository up; a repo under any other owner is a 404, never a 403. */
function lookupRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.viewer.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

export function handleRest(
  store: Store,
  origin: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const ctx: Ctx = { store, origin };
  const segments = path.split('/').filter((part) => part !== '');
  // path is under /api/v3; segments[0] === 'api', segments[1] === 'v3'.
  const rest = segments.slice(2);

  // API root.
  if (rest.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos',
        user_search_url: '/api/v3/search/users?q={query}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0' });
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(userJson(ctx));
  }

  // POST /user/repos and GET /user/repos.
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Problems parsing JSON');
      const name = asString(input.name);
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('name is required and must be a valid repository name');
      const repo = store.createRepo(store.viewer.login, name, {
        private: typeof input.private === 'boolean' ? input.private : false,
        description: asString(input.description) ?? '',
      });
      if (repo === null) return unprocessable('Repository already exists');
      return created(repoJson(ctx, repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(store.viewer.login);
      const { page, headers } = paginate(repos, query, '/api/v3/user/repos', origin);
      return ok(page.map((repo) => repoJson(ctx, repo)), headers);
    }
    return notFound();
  }

  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1] as string);
    const name = decodeURIComponent(rest[2] as string);
    const repo = lookupRepo(ctx, owner, name);
    if (repo === null) return notFound();
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return ok(repoJson(ctx, repo));
      if (method === 'PATCH') {
        const input = bodyObject(body);
        if (input === null) return failure(400, 'Problems parsing JSON');
        const description = asString(input.description);
        if (description !== undefined) repo.description = description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = store.nowIso();
        return ok(repoJson(ctx, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContent();
      }
      return notFound();
    }

    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      const { page, headers } = paginate(branches, query, `/api/v3/repos/${owner}/${name}/branches`, origin);
      return ok(
        page.map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `${origin}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
          protected: false,
        })),
        headers,
      );
    }

    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound();
      return ok({ name: branch, commit: { sha, url: `${origin}/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam ? store.resolveRef(repo, shaParam) : store.defaultTip(repo);
      if (!tip) return ok([]);
      const commits = store.listCommits(repo, tip);
      const { page, headers } = paginate(commits, query, `/api/v3/repos/${owner}/${name}/commits`, origin);
      return ok(
        page.map((commit) => ({
          sha: commit.sha,
          node_id: globalId('Commit', commit.sha),
          commit: {
            author: { name: commit.author.split(' <')[0], email: (commit.author.match(/<([^>]*)>/) ?? [])[1] ?? '', date: new Date(commit.timestamp * 1000).toISOString() },
            committer: { name: commit.committer.split(' <')[0], email: (commit.committer.match(/<([^>]*)>/) ?? [])[1] ?? '', date: new Date(commit.timestamp * 1000).toISOString() },
            message: commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message,
            tree: { sha: parseCommit((repo.objects.get(commit.sha) as { data: Buffer }).data).tree },
          },
          url: `${origin}/api/v3/repos/${owner}/${name}/commits/${commit.sha}`,
          html_url: `${origin}/${owner}/${name}/commit/${commit.sha}`,
          parents: parseCommit((repo.objects.get(commit.sha) as { data: Buffer }).data).parents.map((parent) => ({ sha: parent })),
        })),
        headers,
      );
    }

    // Git Data: refs.
    if (tail[0] === 'git' && tail[1] === 'refs' && method === 'POST' && tail.length === 2) {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Problems parsing JSON');
      const ref = asString(input.ref);
      const sha = asString(input.sha);
      if (!ref || !ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      if (!sha || !repo.objects.has(sha)) return unprocessable('sha does not exist');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return created({ ref, node_id: globalId('Ref', `${repo.id}:${ref}`), url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${origin}/api/v3/repos/${owner}/${name}/git/${repo.objects.get(sha)?.type}s/${sha}` } });
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && method === 'GET' && tail.length === 2) {
      return ok(
        [...repo.refs.keys()].sort().map((ref) => ({
          ref,
          node_id: globalId('Ref', `${repo.id}:${ref}`),
          url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha: repo.refs.get(ref) as string, type: repo.objects.get(repo.refs.get(ref) as string)?.type ?? 'commit' },
        })),
      );
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return ok({
        ref,
        node_id: globalId('Ref', `${repo.id}:${ref}`),
        url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
      });
    }

    // Contents.
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'PUT') {
        const input = bodyObject(body);
        if (input === null) return failure(400, 'Problems parsing JSON');
        const message = asString(input.message);
        const content = asString(input.content);
        if (!message || content === undefined) return unprocessable('message and content are required');
        const branch = asString(input.branch) ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const flat = tip ? store.flattenTree(repo, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree) : new Map<string, { mode: string; oid: string }>();
        const existing = flat.get(filePath);
        const sha = asString(input.sha);
        if (existing && sha === undefined) return unprocessable('sha is required to update a file');
        if (existing && sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return failure(409, 'sha does not match the current file');
        if (!existing && sha !== undefined) return unprocessable('sha was supplied for a file that does not exist');
        const bytes = Buffer.from(content, 'base64');
        const { commitSha, blobOid } = store.commitFiles(repo, branch, new Map([[filePath, bytes]]), message);
        return {
          status: existing ? 200 : 201,
          body: {
            content: {
              name: filePath.split('/').pop(),
              path: filePath,
              sha: blobOid,
              size: bytes.length,
              url: `${origin}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
              html_url: `${origin}/${owner}/${name}/blob/${branch}/${filePath}`,
              git_url: `${origin}/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
              download_url: `${origin}/${owner}/${name}/raw/${branch}/${filePath}`,
              type: 'file',
              encoding: 'base64',
              content: bytes.toString('base64'),
            },
            commit: { sha: commitSha, node_id: globalId('Commit', commitSha), message, url: `${origin}/api/v3/repos/${owner}/${name}/commits/${commitSha}` },
          },
        };
      }
      if (method === 'DELETE') {
        const input = bodyObject(body) ?? {};
        const message = asString(input.message) ?? `Delete ${filePath}`;
        const branch = asString(input.branch) ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return notFound();
        const flat = store.flattenTree(repo, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree);
        const existing = flat.get(filePath);
        if (!existing) return notFound();
        const sha = asString(input.sha);
        if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return failure(409, 'sha does not match the current file');
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (commitSha === null) return notFound();
        return ok({ commit: { sha: commitSha, node_id: globalId('Commit', commitSha), message, url: `${origin}/api/v3/repos/${owner}/${name}/commits/${commitSha}` } });
      }
      if (method === 'GET') {
        const refParam = query.get('ref');
        const tip = refParam ? store.resolveRef(repo, refParam) : store.defaultTip(repo);
        if (!tip) return notFound();
        const flat = store.flattenTree(repo, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree);
        const entry = filePath === '' ? null : flat.get(filePath);
        if (filePath === '' || entry?.mode === '40000') {
          // Directory listing: immediate children.
          const prefix = filePath === '' ? '' : `${filePath}/`;
          const children = new Map<string, { mode: string; oid: string }>();
          for (const [path, child] of flat) {
            if (!path.startsWith(prefix) || path === filePath) continue;
            const rest = path.slice(prefix.length);
            const first = rest.split('/')[0] as string;
            if (!children.has(first)) {
              // A directory child is the subtree entry; a file child is itself.
              if (rest.includes('/')) {
                const dirEntry = flat.get(`${prefix}${first}`);
                if (dirEntry) children.set(first, dirEntry);
              } else {
                children.set(first, child);
              }
            }
          }
          const listed = [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
          return ok(
            listed.map(([childName, child]) => {
              const childPath = `${prefix}${childName}`;
              const isDir = child.mode === '40000';
              return {
                type: isDir ? 'dir' : 'file',
                size: isDir ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
                name: childName,
                path: childPath,
                sha: child.oid,
                url: `${origin}/api/v3/repos/${owner}/${name}/contents/${childPath}`,
                git_url: `${origin}/api/v3/repos/${owner}/${name}/git/${isDir ? 'trees' : 'blobs'}/${child.oid}`,
                html_url: `${origin}/${owner}/${name}/${isDir ? 'tree' : 'blob'}/${refParam ?? repo.defaultBranch}/${childPath}`,
                download_url: isDir ? null : `${origin}/${owner}/${name}/raw/${refParam ?? repo.defaultBranch}/${childPath}`,
              };
            }),
          );
        }
        if (!entry) return notFound();
        const object = repo.objects.get(entry.oid);
        if (!object || object.type !== 'blob') return notFound();
        return ok({
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: object.data.toString('base64'),
          sha: entry.oid,
          url: `${origin}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
          git_url: `${origin}/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`,
          html_url: `${origin}/${owner}/${name}/blob/${refParam ?? repo.defaultBranch}/${filePath}`,
          download_url: `${origin}/${owner}/${name}/raw/${refParam ?? repo.defaultBranch}/${filePath}`,
        });
      }
      return notFound();
    }

    // Labels.
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return ok([...repo.labels.keys()].map((name) => labelJson(ctx, repo, name)));
      }
      if (method === 'POST' && tail.length === 1) {
        const input = bodyObject(body);
        if (input === null) return failure(400, 'Problems parsing JSON');
        const name = asString(input.name);
        if (!name) return unprocessable('name is required');
        const label = store.createLabel(repo, name, asString(input.color) ?? 'ededed', asString(input.description) ?? '');
        return created(labelJson(ctx, repo, label.name));
      }
      return notFound();
    }

    // Issues.
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const input = bodyObject(body);
          if (input === null) return failure(400, 'Problems parsing JSON');
          const title = asString(input.title);
          if (!title) return unprocessable('title is required');
          const labels = asStringArray(input.labels);
          const issue = store.createIssue(repo, title, asString(input.body) ?? '', labels);
          if ('error' in issue) return unprocessable(issue.error);
          return created(issueJson(ctx, repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let items = store.listIssuesAndPulls(repo);
          if (state !== 'all') items = items.filter((item) => item.state === state);
          items = [...items].sort((a, b) => {
            const byNumber = sort === 'created' ? a.number - b.number : a.seq - b.seq;
            return direction === 'asc' ? byNumber : -byNumber;
          });
          const { page, headers } = paginate(items, query, `/api/v3/repos/${owner}/${name}/issues`, origin);
          return ok(
            page.map((item) => {
              if ('head' in item) {
                const pull = item as PullRecord;
                return {
                  id: pull.id,
                  node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
                  url: `${ctx.origin}/api/v3/repos/${owner}/${name}/issues/${pull.number}`,
                  html_url: `${ctx.origin}/${owner}/${name}/pull/${pull.number}`,
                  number: pull.number,
                  title: pull.title,
                  body: pull.body,
                  state: pull.state,
                  user: { login: pull.user, id: ctx.store.viewer.id, type: 'User' },
                  labels: [],
                  assignee: null,
                  locked: false,
                  comments: 0,
                  created_at: pull.createdAt,
                  updated_at: pull.updatedAt,
                  closed_at: pull.state === 'closed' ? pull.updatedAt : null,
                  pull_request: { url: `${origin}/api/v3/repos/${owner}/${name}/pulls/${pull.number}` },
                };
              }
              return issueJson(ctx, repo, item as IssueRecord);
            }),
            headers,
          );
        }
        return notFound();
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return notFound();
      const issue = store.getIssue(repo, number);
      if (tail.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return ok(issueJson(ctx, repo, issue));
        if (method === 'PATCH') {
          const input = bodyObject(body);
          if (input === null) return failure(400, 'Problems parsing JSON');
          const state = asString(input.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(input.title);
          if (title !== undefined) {
            // IssueRecord.title is readonly in the type; mutate through a cast.
            (issue as { title: string }).title = title;
          }
          const bodyText = asString(input.body);
          if (bodyText !== undefined) issue.body = bodyText;
          if (Array.isArray(input.labels)) {
            const labels = asStringArray(input.labels);
            for (const label of labels) if (!repo.labels.has(label)) return unprocessable(`Label '${label}' does not exist`);
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          return ok(issueJson(ctx, repo, issue));
        }
        return notFound();
      }
      if (tail[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'POST') {
          const input = bodyObject(body);
          if (input === null) return failure(400, 'Problems parsing JSON');
          const commentBody = asString(input.body);
          if (!commentBody) return unprocessable('body is required');
          const comment = { id: store.allocateId(), body: commentBody, user: store.viewer.login, createdAt: store.nowIso() };
          issue.comments.push(comment);
          issue.updatedAt = store.nowIso();
          return created(commentJson(ctx, repo, number, comment));
        }
        if (method === 'GET') {
          const { page, headers } = paginate(issue.comments, query, `/api/v3/repos/${owner}/${name}/issues/${number}/comments`, origin);
          return ok(page.map((comment) => commentJson(ctx, repo, number, comment)), headers);
        }
        return notFound();
      }
      return notFound();
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const input = bodyObject(body);
          if (input === null) return failure(400, 'Problems parsing JSON');
          const title = asString(input.title);
          const head = asString(input.head);
          const base = asString(input.base);
          if (!title || !head || !base) return unprocessable('title, head and base are required');
          const pull = store.createPull(repo, title, asString(input.body) ?? '', head, base);
          if ('error' in pull) return unprocessable(pull.error);
          return created(pullJson(ctx, repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, headers } = paginate(pulls, query, `/api/v3/repos/${owner}/${name}/pulls`, origin);
          return ok(page.map((pull) => pullJson(ctx, repo, pull)), headers);
        }
        return notFound();
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return notFound();
      const pull = store.getPull(repo, number);
      if (!pull) return notFound();
      if (tail.length === 2) {
        if (method === 'GET') return ok(pullJson(ctx, repo, pull));
        return notFound();
      }
      if (tail[2] === 'files' && tail.length === 3 && method === 'GET') {
        const files = store.pullFiles(repo, pull);
        return ok(
          files.map((file) => ({
            sha: file.newOid ?? file.oldOid ?? '',
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            blob_url: `${origin}/${owner}/${name}/blob/${pull.head}/${file.filename}`,
            raw_url: `${origin}/${owner}/${name}/raw/${pull.head}/${file.filename}`,
            contents_url: `${origin}/api/v3/repos/${owner}/${name}/contents/${file.filename}?ref=${pull.head}`,
          })),
        );
      }
      if (tail[2] === 'merge' && tail.length === 3 && method === 'PUT') {
        const input = bodyObject(body) ?? {};
        const methodName = asString(input.merge_method) ?? 'merge';
        const merged = store.mergePull(repo, pull, methodName);
        if (typeof merged === 'object') {
          if (merged.error === 'conflict') return failure(405, 'Merge conflict');
          return failure(405, 'Pull request is already merged');
        }
        return ok({ sha: merged, merged: true, message: `Pull Request successfully merged` });
      }
      return notFound();
    }
  }

  return notFound();
}

// Re-exported for the GraphQL layer's issue/pull shaping.
export { issueJson, pullJson, userJson, repoJson };
export type { Ctx };
