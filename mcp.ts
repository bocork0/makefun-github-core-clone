// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp, plain JSON
// responses): the modern 2026-07-28 era via server/discover, with the legacy
// initialize handshake as a fallback. Tools are the six the suite requires
// plus a few extras, all backed by the same store as REST and GraphQL.

import { globalId } from './rest.ts';
import type { Store } from './store.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list, frozen so tools/list is byte-identical on every call. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login; defaults to the authenticated user.' }),
        name: Object.freeze({ type: 'string', description: 'Repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Issue title.' }),
        body: Object.freeze({ type: 'string', description: 'Issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'Pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
  Object.freeze({
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get a single issue by owner, repository and number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        issue_number: Object.freeze({ type: 'number', description: 'Issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
    }),
  }),
]);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolResult(data: unknown): Json {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}
function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Resolve owner/repo to a repo, or a tool error message when it does not exist. */
function resolveRepo(store: Store, args: Json): { repo: ReturnType<Store['getRepo']>; error: string | null } {
  const owner = asString(args.owner) ?? store.viewer.login;
  const name = asString(args.repo) ?? asString(args.name);
  if (!name) return { repo: undefined, error: 'repo is required' };
  if (owner !== store.viewer.login) return { repo: undefined, error: 'Repository not found' };
  const repo = store.getRepo(owner, name);
  if (!repo) return { repo: undefined, error: 'Repository not found' };
  return { repo, error: null };
}

function callTool(store: Store, origin: string, name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (!repoName) return toolError('name is required');
      const repo = store.createRepo(store.viewer.login, repoName, {
        private: typeof args.private === 'boolean' ? args.private : false,
        description: asString(args.description) ?? '',
      });
      if (repo === null) return toolError('Repository already exists');
      return toolResult({
        id: repo.id,
        node_id: globalId('Repository', String(repo.id)),
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
        html_url: `${origin}/${repo.owner}/${repo.name}`,
        url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
      });
    }
    case 'get_repo': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      return toolResult({
        id: found.id,
        node_id: globalId('Repository', String(found.id)),
        name: found.name,
        full_name: `${found.owner}/${found.name}`,
        owner: { login: found.owner },
        private: found.private,
        description: found.description,
        default_branch: found.defaultBranch,
        html_url: `${origin}/${found.owner}/${found.name}`,
        url: `${origin}/api/v3/repos/${found.owner}/${found.name}`,
      });
    }
    case 'create_issue': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      const title = asString(args.title);
      if (!title) return toolError('title is required');
      const created = store.createIssue(found, title, asString(args.body) ?? '', []);
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        node_id: globalId('Issue', `${found.id}:${created.number}`),
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        url: `${origin}/api/v3/repos/${found.owner}/${found.name}/issues/${created.number}`,
        html_url: `${origin}/${found.owner}/${found.name}/issues/${created.number}`,
      });
    }
    case 'list_issues': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      const state = asString(args.state) ?? 'open';
      let items = store.listIssuesAndPulls(found);
      if (state !== 'all') items = items.filter((item) => item.state === state);
      return toolResult({
        issues: items.map((item) => ({
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body,
          state: item.state,
          url: `${origin}/api/v3/repos/${found.owner}/${found.name}/issues/${item.number}`,
        })),
      });
    }
    case 'create_pull_request': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (!title || !head || !base) return toolError('title, head and base are required');
      const created = store.createPull(found, title, asString(args.body) ?? '', head, base);
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        node_id: globalId('PullRequest', `${found.id}:${created.number}`),
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.head, sha: found.refs.get(`refs/heads/${created.head}`) ?? created.headSha },
        base: { ref: created.base, sha: found.refs.get(`refs/heads/${created.base}`) ?? created.baseSha },
        url: `${origin}/api/v3/repos/${found.owner}/${found.name}/pulls/${created.number}`,
        html_url: `${origin}/${found.owner}/${found.name}/pull/${created.number}`,
      });
    }
    case 'merge_pull_request': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      const number = asNumber(args.pull_number);
      if (number === undefined) return toolError('pull_number is required');
      const pull = store.getPull(found, number);
      if (!pull) return toolError('Pull request not found');
      const merged = store.mergePull(found, pull, 'merge');
      if (typeof merged === 'object') return toolError(merged.error === 'conflict' ? 'Merge conflict' : 'Pull request is already merged');
      return toolResult({ number: pull.number, merged: true, sha: merged, merge_commit_sha: merged, state: 'closed' });
    }
    case 'list_repos': {
      return toolResult({
        repos: store.listRepos(store.viewer.login).map((repo) => ({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          private: repo.private,
          default_branch: repo.defaultBranch,
        })),
      });
    }
    case 'get_issue': {
      const { repo, error } = resolveRepo(store, args);
      if (error) return toolError(error);
      const found = repo as NonNullable<typeof repo>;
      const number = asNumber(args.issue_number);
      if (number === undefined) return toolError('issue_number is required');
      const issue = store.getIssue(found, number);
      if (!issue) return toolError('Issue not found');
      return toolResult({
        id: issue.id,
        node_id: globalId('Issue', `${found.id}:${issue.number}`),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `${origin}/api/v3/repos/${found.owner}/${found.name}/issues/${issue.number}`,
      });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleMethod(store: Store, origin: string, method: string, params: unknown, id: unknown): Json | null {
  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const requested = (params as Json | null)?.protocolVersion;
      const supported = [MODERN_REVISION, ...LEGACY_REVISIONS];
      const protocolVersion = typeof requested === 'string' && supported.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
      // A notification: no JSON-RPC response.
      return null;
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const args = (params as Json | null) ?? {};
      const toolName = asString(args.name);
      if (!toolName) return rpcError(id, -32602, 'tools/call requires a tool name');
      if (!TOOL_NAMES.has(toolName)) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const tool = TOOLS.find((candidate) => candidate.name === toolName) as ToolDef;
      const toolArgs = (args.arguments as Json | null) ?? {};
      const missing = tool.inputSchema.required.filter((field) => toolArgs[field] === undefined);
      if (missing.length > 0) {
        return rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`));
      }
      return rpcResult(id, callTool(store, origin, toolName, toolArgs));
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export interface McpResult {
  status: number;
  body: unknown;
}

/** POST /mcp (and DELETE /mcp). `rawBody` is the exact request bytes. */
export function handleMcp(store: Store, origin: string, method: string, rawBody: Buffer): McpResult {
  if (method === 'DELETE') {
    return { status: 200, body: {} };
  }
  if (method !== 'POST') {
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const { method: rpcMethod, params, id } = request as { method?: unknown; params?: unknown; id?: unknown };
  if (typeof rpcMethod !== 'string') {
    return { status: 400, body: rpcError(id ?? null, -32600, 'Invalid Request') };
  }
  const response = handleMethod(store, origin, rpcMethod, params, id);
  if (response === null) {
    // Notification: acknowledge with an empty 200.
    return { status: 200, body: {} };
  }
  return { status: 200, body: response };
}
