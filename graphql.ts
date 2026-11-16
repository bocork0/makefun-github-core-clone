// graphql.ts — a small GraphQL executor for the shapes gh and
// github-mcp-server send: queries, mutations, variables, fragments, batching,
// __type introspection, Relay-style global ids and cursor pagination.

import { globalId, decodeGlobalId } from './rest.ts';
import type { IssueRecord, PullRecord, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (recursive descent over the document text)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Selection {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name: string; // field name / fragment name / type condition
  alias?: string;
  arguments?: { name: string; value: ValueNode }[];
  selections?: Selection[];
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  variableDefinitions: { name: string; default?: ValueNode }[];
  selections: Selection[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }
  private next(): string {
    return this.src[this.pos++] ?? '';
  }
  private skipIgnored(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        this.pos++;
      } else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else break;
    }
  }
  private expect(char: string): void {
    this.skipIgnored();
    if (this.peek() !== char) throw new Error(`Expected '${char}' at ${this.pos}`);
    this.pos++;
  }
  private match(char: string): boolean {
    this.skipIgnored();
    if (this.peek() === char) {
      this.pos++;
      return true;
    }
    return false;
  }
  private readName(): string {
    this.skipIgnored();
    let name = '';
    while (/[_A-Za-z0-9]/.test(this.peek())) name += this.next();
    if (name === '') throw new Error(`Expected name at ${this.pos}`);
    return name;
  }
  private readString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.next();
      if (c === '') throw new Error('Unterminated string');
      if (c === '"') break;
      if (c === '\\') {
        const esc = this.next();
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
      } else out += c;
    }
    return out;
  }
  private readNumber(): ValueNode {
    this.skipIgnored();
    let text = '';
    if (this.peek() === '-') text += this.next();
    while (/[0-9.]/.test(this.peek())) text += this.next();
    if (/[eE]/.test(this.peek())) {
      text += this.next();
      if (this.peek() === '+' || this.peek() === '-') text += this.next();
      while (/[0-9]/.test(this.peek())) text += this.next();
    }
    const value = Number(text);
    return text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value } : { kind: 'int', value };
  }
  private readValue(): ValueNode {
    this.skipIgnored();
    const c = this.peek();
    if (c === '"') return { kind: 'string', value: this.readString() };
    if (c === '[') {
      this.pos++;
      const values: ValueNode[] = [];
      while (!this.match(']')) {
        values.push(this.readValue());
        this.skipIgnored();
      }
      return { kind: 'list', values };
    }
    if (c === '{') {
      this.pos++;
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.match('}')) {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.readValue() });
        this.skipIgnored();
      }
      return { kind: 'object', fields };
    }
    if (c === '$') {
      this.pos++;
      return { kind: 'variable', name: this.readName() };
    }
    if (c === '-' || /[0-9]/.test(c)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
  private readArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expect('(');
    while (!this.match(')')) {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.readValue() });
      this.skipIgnored();
    }
    return args;
  }
  private readDirectives(): void {
    for (;;) {
      this.skipIgnored();
      if (this.peek() !== '@') break;
      this.pos++;
      this.readName();
      this.skipIgnored();
      if (this.peek() === '(') this.readArguments();
    }
  }
  private readSelections(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.match('}')) break;
      if (this.peek() === '') throw new Error('Unterminated selection set');
      if (this.src.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipIgnored();
        if (this.peek() === '{') {
          this.readDirectives();
          selections.push({ kind: 'inlineFragment', name: '', selections: this.readSelections() });
        } else if (/[_A-Za-z]/.test(this.peek())) {
          const word = this.readName();
          if (word === 'on') {
            const typeCondition = this.readName();
            this.readDirectives();
            selections.push({ kind: 'inlineFragment', name: typeCondition, selections: this.readSelections() });
          } else {
            this.readDirectives();
            selections.push({ kind: 'fragmentSpread', name: word });
          }
        } else {
          this.readDirectives();
          selections.push({ kind: 'inlineFragment', name: '', selections: this.readSelections() });
        }
        continue;
      }
      let name = this.readName();
      let alias: string | undefined;
      this.skipIgnored();
      if (this.peek() === ':') {
        this.pos++;
        alias = name;
        name = this.readName();
      }
      let args: { name: string; value: ValueNode }[] | undefined;
      this.skipIgnored();
      if (this.peek() === '(') args = this.readArguments();
      this.readDirectives();
      let sub: Selection[] | undefined;
      this.skipIgnored();
      if (this.peek() === '{') sub = this.readSelections();
      selections.push({ kind: 'field', name, alias, arguments: args, selections: sub });
    }
    return selections;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    for (;;) {
      this.skipIgnored();
      if (this.pos >= this.src.length) break;
      const word = this.readName();
      if (word === 'fragment') {
        const name = this.readName();
        const on = this.readName();
        if (on !== 'on') throw new Error('Expected "on" in fragment');
        const typeCondition = this.readName();
        this.readDirectives();
        fragments.set(name, { name, typeCondition, selections: this.readSelections() });
      } else if (word === 'query' || word === 'mutation') {
        let opName: string | undefined;
        this.skipIgnored();
        if (/[_A-Za-z]/.test(this.peek())) opName = this.readName();
        const variableDefinitions: { name: string; default?: ValueNode }[] = [];
        this.skipIgnored();
        if (this.peek() === '(') {
          this.pos++;
          for (;;) {
            this.skipIgnored();
            if (this.match(')')) break;
            if (this.peek() !== '$') throw new Error('Expected variable');
            this.pos++;
            const varName = this.readName();
            this.expect(':');
            // Type: a name, possibly wrapped in [ ] or followed by ! — skip it.
            this.skipIgnored();
            if (this.peek() === '[') {
              let depth = 0;
              while (this.pos < this.src.length) {
                const c = this.next();
                if (c === '[') depth++;
                if (c === ']') {
                  depth--;
                  if (depth === 0) break;
                }
              }
            } else {
              this.readName();
            }
            this.skipIgnored();
            if (this.peek() === '!') this.pos++;
            this.skipIgnored();
            let def: ValueNode | undefined;
            if (this.peek() === '=') {
              this.pos++;
              def = this.readValue();
            }
            variableDefinitions.push({ name: varName, default: def });
          }
        }
        this.readDirectives();
        operations.push({ type: word, name: opName, variableDefinitions, selections: this.readSelections() });
      } else if (word === 'subscription') {
        throw new Error('Subscriptions are not supported');
      } else {
        throw new Error(`Unexpected keyword '${word}'`);
      }
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(args: { name: string; value: ValueNode }[] | undefined, name: string, variables: Record<string, unknown>): unknown {
  const arg = args?.find((entry) => entry.name === name);
  return arg ? resolveValue(arg.value, variables) : undefined;
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closedAt'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'repository', 'closedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'private'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'url'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  origin: string;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: { message: string }[];
}

function unknownField(ctx: ExecCtx, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function applySelections(ctx: ExecCtx, typeName: string, value: Record<string, unknown> | null, selections: Selection[] | undefined, resolver: (ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>) => unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  if (!selections) return out;
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, applySelections(ctx, typeName, value, fragment.selections, resolver) ?? {});
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.name === '' || selection.name === typeName || (value.__typename !== undefined && selection.name === value.__typename)) {
        Object.assign(out, applySelections(ctx, typeName, value, selection.selections, resolver) ?? {});
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolver(ctx, selection.name, selection.arguments, selection.selections, value);
    if (resolved === undefined) {
      // Resolver reported the unknown field already; emit null for the field.
      out[key] = null;
    } else {
      out[key] = resolved;
    }
  }
  return out;
}

function issueObject(ctx: ExecCtx, repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __issue: issue,
    __repo: repo,
    id: globalId('Issue', `${repo.id}:${issue.number}`),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

function pullObject(ctx: ExecCtx, repo: Repo, pull: PullRecord): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __pull: pull,
    __repo: repo,
    id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    databaseId: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    headRefName: pull.head,
    baseRefName: pull.base,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
  };
}

function repoObject(ctx: ExecCtx, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    private: repo.private,
  };
}

function userObject(ctx: ExecCtx): Record<string, unknown> {
  const viewer = ctx.store.viewer;
  return {
    __typename: 'User',
    id: globalId('User', String(viewer.id)),
    databaseId: viewer.id,
    login: viewer.login,
    name: viewer.name,
    email: viewer.email,
    url: `${ctx.origin}/${viewer.login}`,
  };
}

function resolveIssueField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  const issue = parent.__issue as IssueRecord;
  const repo = parent.__repo as Repo;
  switch (field) {
    case 'id':
    case 'databaseId':
    case 'number':
    case 'title':
    case 'body':
    case 'state':
    case 'url':
    case 'createdAt':
    case 'updatedAt':
    case 'closedAt':
      return parent[field];
    case 'author':
      return applySelections(ctx, 'User', { __typename: 'User', id: globalId('User', String(ctx.store.viewer.id)), databaseId: ctx.store.viewer.id, login: issue.user, name: issue.user, email: '', url: `${ctx.origin}/${issue.user}` }, selections, resolveUserField);
    case 'repository':
      return applySelections(ctx, 'Repository', repoObject(ctx, repo), selections, resolveRepoField);
    case 'labels': {
      const nodes = issue.labels.map((name) => ({ __typename: 'Label', id: globalId('Label', `${repo.id}:${name}`), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' }));
      return applySelections(ctx, 'LabelConnection', { __typename: 'LabelConnection', __nodes: nodes }, selections, resolveConnectionField);
    }
    case 'comments': {
      const nodes = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
        databaseId: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        __author: comment.user,
      }));
      return applySelections(ctx, 'IssueCommentConnection', { __typename: 'IssueCommentConnection', __nodes: nodes }, selections, resolveConnectionField);
    }
    default:
      return unknownField(ctx, 'Issue', field);
  }
}

function resolveUserField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
    case 'login':
    case 'name':
    case 'email':
    case 'url':
      return parent[field] ?? null;
    case 'databaseId':
      return parent.databaseId ?? null;
    default:
      return unknownField(ctx, 'User', field);
  }
}

function resolveConnectionField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  const nodes = (parent.__nodes as Record<string, unknown>[]) ?? [];
  switch (field) {
    case 'nodes':
      return nodes.map((node) => applySelections(ctx, String(node.__typename ?? 'Issue'), node, selections, fieldResolverFor(String(node.__typename ?? 'Issue'))));
    case 'edges':
      return nodes.map((node, index) => {
        const cursor = cursorFor((node.number as number | undefined) ?? (node.databaseId as number | undefined) ?? index + 1);
        return applySelections(ctx, 'Edge', { __typename: 'Edge', __node: node, cursor }, selections, resolveEdgeField);
      });
    case 'totalCount':
      return nodes.length;
    case 'pageInfo': {
      const pageInfo = (parent.__pageInfo as Record<string, unknown>) ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      return applySelections(ctx, 'PageInfo', pageInfo, selections, resolvePageInfoField);
    }
    default:
      return unknownField(ctx, 'Connection', field);
  }
}

function resolveEdgeField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'cursor':
      return parent.cursor;
    case 'node': {
      const node = parent.__node as Record<string, unknown>;
      return applySelections(ctx, String(node.__typename ?? 'Issue'), node, selections, fieldResolverFor(String(node.__typename ?? 'Issue')));
    }
    default:
      return unknownField(ctx, 'Edge', field);
  }
}

function resolvePageInfoField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'hasNextPage':
    case 'hasPreviousPage':
    case 'startCursor':
    case 'endCursor':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, 'PageInfo', field);
  }
}

function resolvePullField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  const pull = parent.__pull as PullRecord;
  const repo = parent.__repo as Repo;
  switch (field) {
    case 'id':
    case 'databaseId':
    case 'number':
    case 'title':
    case 'body':
    case 'state':
    case 'url':
    case 'createdAt':
    case 'updatedAt':
    case 'closedAt':
    case 'headRefName':
    case 'baseRefName':
    case 'merged':
    case 'mergedAt':
      return parent[field];
    case 'author':
      return applySelections(ctx, 'User', { __typename: 'User', id: globalId('User', String(ctx.store.viewer.id)), databaseId: ctx.store.viewer.id, login: pull.user, name: pull.user, email: '', url: `${ctx.origin}/${pull.user}` }, selections, resolveUserField);
    case 'repository':
      return applySelections(ctx, 'Repository', repoObject(ctx, repo), selections, resolveRepoField);
    case 'headRef':
      return applySelections(ctx, 'Ref', { __typename: 'Ref', id: globalId('Ref', `${repo.id}:refs/heads/${pull.head}`), name: pull.head, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha } }, selections, resolveRefField);
    case 'baseRef':
      return applySelections(ctx, 'Ref', { __typename: 'Ref', id: globalId('Ref', `${repo.id}:refs/heads/${pull.base}`), name: pull.base, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha } }, selections, resolveRefField);
    case 'mergeable': {
      const conflicts = ctx.store.pullConflicts(repo, pull);
      return conflicts ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'mergeCommit': {
      if (!pull.mergeCommitSha) return null;
      return applySelections(ctx, 'Commit', { __typename: 'Commit', oid: pull.mergeCommitSha }, selections, resolveCommitField);
    }
    case 'files': {
      const files = ctx.store.pullFiles(repo, pull);
      const nodes = files.map((file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const first = argValue(args, 'first', ctx.variables) as number | undefined;
      const sliced = typeof first === 'number' ? nodes.slice(0, first) : nodes;
      return applySelections(ctx, 'PullRequestFileConnection', { __typename: 'PullRequestFileConnection', __nodes: sliced }, selections, resolveConnectionField);
    }
    default:
      return unknownField(ctx, 'PullRequest', field);
  }
}

function resolveRefField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
    case 'name':
    case 'prefix':
      return parent[field] ?? null;
    case 'target': {
      const target = parent.target as Record<string, unknown> | undefined;
      if (!target) return null;
      return applySelections(ctx, 'Commit', target, selections, resolveCommitField);
    }
    default:
      return unknownField(ctx, 'Ref', field);
  }
}

function resolveCommitField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'oid':
    case 'id':
      return parent.oid ?? parent.id ?? null;
    default:
      return unknownField(ctx, 'Commit', field);
  }
}

function resolveRepoField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  const repo = parent.__repo as Repo;
  switch (field) {
    case 'id':
    case 'databaseId':
    case 'name':
    case 'nameWithOwner':
    case 'description':
    case 'url':
    case 'createdAt':
    case 'updatedAt':
    case 'viewerPermission':
    case 'hasIssuesEnabled':
    case 'isPrivate':
    case 'private':
      return parent[field];
    case 'owner':
      return applySelections(ctx, 'User', { __typename: 'User', id: globalId('User', String(ctx.store.viewer.id)), databaseId: ctx.store.viewer.id, login: repo.owner, name: repo.owner, email: '', url: `${ctx.origin}/${repo.owner}` }, selections, resolveUserField);
    case 'defaultBranchRef': {
      const branch = repo.defaultBranch;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return null;
      return applySelections(ctx, 'Ref', { __typename: 'Ref', id: globalId('Ref', `${repo.id}:refs/heads/${branch}`), name: branch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: sha } }, selections, resolveRefField);
    }
    case 'issue': {
      const number = argValue(args, 'number', ctx.variables) as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = ctx.store.getIssue(repo, number);
      if (!issue) return null;
      return applySelections(ctx, 'Issue', issueObject(ctx, repo, issue), selections, resolveIssueField);
    }
    case 'issues': {
      const first = (argValue(args, 'first', ctx.variables) as number | undefined) ?? 100;
      const after = argValue(args, 'after', ctx.variables) as string | undefined;
      const states = (argValue(args, 'states', ctx.variables) as string[] | undefined) ?? [];
      const orderBy = (argValue(args, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined) ?? {};
      let items = ctx.store.listIssuesAndPulls(repo).filter((item) => !('head' in item));
      if (states.length > 0) {
        items = items.filter((item) => states.includes(item.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const direction = (orderBy.direction ?? 'DESC').toUpperCase();
      items = [...items].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      let startIndex = 0;
      if (after) {
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          const index = items.findIndex((item) => item.number === afterNumber);
          if (index >= 0) startIndex = index + 1;
        }
      }
      const page = items.slice(startIndex, startIndex + first);
      const nodes = page.map((item) => issueObject(ctx, repo, item as IssueRecord));
      const pageInfo = {
        hasNextPage: startIndex + first < items.length,
        hasPreviousPage: startIndex > 0,
        startCursor: nodes.length > 0 ? cursorFor(nodes[0]?.number as number) : null,
        endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]?.number as number) : null,
      };
      return applySelections(ctx, 'IssueConnection', { __typename: 'IssueConnection', __nodes: nodes, __pageInfo: pageInfo }, selections, resolveConnectionField);
    }
    case 'pullRequest': {
      const number = argValue(args, 'number', ctx.variables) as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = ctx.store.getPull(repo, number);
      if (!pull) return null;
      return applySelections(ctx, 'PullRequest', pullObject(ctx, repo, pull), selections, resolvePullField);
    }
    case 'pullRequests': {
      const first = (argValue(args, 'first', ctx.variables) as number | undefined) ?? 100;
      const after = argValue(args, 'after', ctx.variables) as string | undefined;
      const states = (argValue(args, 'states', ctx.variables) as string[] | undefined) ?? [];
      let items = [...repo.pulls];
      if (states.length > 0) {
        items = items.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      items.sort((a, b) => b.number - a.number);
      let startIndex = 0;
      if (after) {
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          const index = items.findIndex((item) => item.number === afterNumber);
          if (index >= 0) startIndex = index + 1;
        }
      }
      const page = items.slice(startIndex, startIndex + first);
      const nodes = page.map((pull) => pullObject(ctx, repo, pull));
      const pageInfo = {
        hasNextPage: startIndex + first < items.length,
        hasPreviousPage: startIndex > 0,
        startCursor: nodes.length > 0 ? cursorFor(nodes[0]?.number as number) : null,
        endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]?.number as number) : null,
      };
      return applySelections(ctx, 'PullRequestConnection', { __typename: 'PullRequestConnection', __nodes: nodes, __pageInfo: pageInfo }, selections, resolveConnectionField);
    }
    default:
      return unknownField(ctx, 'Repository', field);
  }
}

function fieldResolverFor(typeName: string): (ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>) => unknown {
  switch (typeName) {
    case 'Issue':
      return resolveIssueField;
    case 'PullRequest':
      return resolvePullField;
    case 'Repository':
      return resolveRepoField;
    case 'User':
      return resolveUserField;
    case 'Ref':
      return resolveRefField;
    case 'Commit':
      return resolveCommitField;
    case 'IssueComment':
      return resolveCommentField;
    case 'Label':
      return resolveLabelField;
    case 'PullRequestFile':
      return resolvePullFileField;
    default:
      return (ctx, field) => unknownField(ctx, typeName, field);
  }
}

function resolveCommentField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
    case 'databaseId':
    case 'body':
    case 'createdAt':
    case 'url':
      return parent[field] ?? null;
    case 'author':
      return applySelections(ctx, 'User', { __typename: 'User', id: globalId('User', String(ctx.store.viewer.id)), databaseId: ctx.store.viewer.id, login: String(parent.__author ?? ctx.store.viewer.login), name: String(parent.__author ?? ctx.store.viewer.login), email: '', url: `${ctx.origin}/${String(parent.__author ?? ctx.store.viewer.login)}` }, selections, resolveUserField);
    default:
      return unknownField(ctx, 'IssueComment', field);
  }
}

function resolveLabelField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
    case 'name':
    case 'color':
    case 'description':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, 'Label', field);
  }
}

function resolvePullFileField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'path':
    case 'additions':
    case 'deletions':
    case 'changeType':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, 'PullRequestFile', field);
  }
}

function resolveRootField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined): unknown {
  switch (field) {
    case 'viewer':
      return applySelections(ctx, 'User', userObject(ctx), selections, resolveUserField);
    case 'repository': {
      const owner = argValue(args, 'owner', ctx.variables) as string | undefined;
      const name = argValue(args, 'name', ctx.variables) as string | undefined;
      if (!owner || !name) return null;
      if (owner !== ctx.store.viewer.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return applySelections(ctx, 'Repository', repoObject(ctx, repo), selections, resolveRepoField);
    }
    case 'node': {
      const id = argValue(args, 'id', ctx.variables) as string | undefined;
      if (!id) return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      const [type] = [decoded.type];
      if (type === 'Repository') {
        const repoId = Number(decoded.key);
        const repo = [...ctx.store.listRepos(ctx.store.viewer.login)].find((candidate) => candidate.id === repoId);
        if (!repo) return null;
        return applySelections(ctx, 'Repository', repoObject(ctx, repo), selections, resolveRepoField);
      }
      if (type === 'Issue' || type === 'PullRequest') {
        const [repoIdText, numberText] = decoded.key.split(':');
        const repo = [...ctx.store.listRepos(ctx.store.viewer.login)].find((candidate) => candidate.id === Number(repoIdText));
        if (!repo) return null;
        if (type === 'Issue') {
          const issue = ctx.store.getIssue(repo, Number(numberText));
          if (!issue) return null;
          return applySelections(ctx, 'Issue', issueObject(ctx, repo, issue), selections, resolveIssueField);
        }
        const pull = ctx.store.getPull(repo, Number(numberText));
        if (!pull) return null;
        return applySelections(ctx, 'PullRequest', pullObject(ctx, repo, pull), selections, resolvePullField);
      }
      if (type === 'User') {
        return applySelections(ctx, 'User', userObject(ctx), selections, resolveUserField);
      }
      return null;
    }
    case '__type': {
      const name = argValue(args, 'name', ctx.variables) as string | undefined;
      if (!name) return null;
      if (name === 'SearchType') {
        return applySelections(ctx, '__Type', {
          __typename: '__Type',
          name: 'SearchType',
          kind: 'ENUM',
          __enumValues: SEARCH_TYPE_VALUES.map((value) => ({ name: value, description: null })),
        }, selections, resolveTypeField);
      }
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return applySelections(ctx, '__Type', {
        __typename: '__Type',
        name,
        kind: 'OBJECT',
        __fields: fields.map((fieldName) => ({ name: fieldName, description: null })),
      }, selections, resolveTypeField);
    }
    case '__schema':
      return applySelections(ctx, '__Schema', { __typename: '__Schema', description: null }, selections, resolveSchemaField);
    default:
      return unknownField(ctx, 'Query', field);
  }
}

function resolveTypeField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'name':
    case 'kind':
    case 'description':
      return parent[field] ?? null;
    case 'fields': {
      const fields = (parent.__fields as Record<string, unknown>[]) ?? [];
      return fields.map((item) => applySelections(ctx, '__Field', item, selections, resolveFieldField));
    }
    case 'enumValues': {
      const values = (parent.__enumValues as Record<string, unknown>[]) ?? [];
      return values.map((item) => applySelections(ctx, '__EnumValue', item, selections, resolveEnumValueField));
    }
    default:
      return unknownField(ctx, '__Type', field);
  }
}

function resolveFieldField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'name':
    case 'description':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, '__Field', field);
  }
}

function resolveEnumValueField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'name':
    case 'description':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, '__EnumValue', field);
  }
}

function resolveSchemaField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined, parent: Record<string, unknown>): unknown {
  switch (field) {
    case 'description':
      return parent[field] ?? null;
    default:
      return unknownField(ctx, '__Schema', field);
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function findRepoByGlobalId(ctx: ExecCtx, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const repoId = Number(decoded.key);
  return [...ctx.store.listRepos(ctx.store.viewer.login)].find((candidate) => candidate.id === repoId) ?? null;
}

function findIssueByGlobalId(ctx: ExecCtx, id: string): { repo: Repo; issue: IssueRecord } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repo = [...ctx.store.listRepos(ctx.store.viewer.login)].find((candidate) => candidate.id === Number(repoIdText));
  if (!repo) return null;
  const issue = ctx.store.getIssue(repo, Number(numberText));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(ctx: ExecCtx, id: string): { repo: Repo; pull: PullRecord } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repo = [...ctx.store.listRepos(ctx.store.viewer.login)].find((candidate) => candidate.id === Number(repoIdText));
  if (!repo) return null;
  const pull = ctx.store.getPull(repo, Number(numberText));
  return pull ? { repo, pull } : null;
}

function resolveMutationField(ctx: ExecCtx, field: string, args: { name: string; value: ValueNode }[] | undefined, selections: Selection[] | undefined): unknown {
  const input = (argValue(args, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return null;
      }
      const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      const issue = applySelections(ctx, 'Issue', issueObject(ctx, repo, created), selections?.find((sel) => sel.name === 'issue')?.selections, resolveIssueField);
      return { issue };
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.store.nowIso();
      const issue = applySelections(ctx, 'Issue', issueObject(ctx, found.repo, found.issue), selections?.find((sel) => sel.name === 'issue')?.selections, resolveIssueField);
      return { issue };
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const created = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      const pullRequest = applySelections(ctx, 'PullRequest', pullObject(ctx, repo, created), selections?.find((sel) => sel.name === 'pullRequest')?.selections, resolvePullField);
      return { pullRequest };
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const methodName = method === 'SQUASH' ? 'squash' : method === 'REBASE' ? 'rebase' : 'merge';
      const merged = ctx.store.mergePull(found.repo, found.pull, methodName);
      if (typeof merged === 'object') {
        ctx.errors.push({ message: merged.error === 'conflict' ? 'Merge conflict' : 'Pull request is already merged' });
        return null;
      }
      const pullRequest = applySelections(ctx, 'PullRequest', pullObject(ctx, found.repo, found.pull), selections?.find((sel) => sel.name === 'pullRequest')?.selections, resolvePullField);
      return { pullRequest };
    }
    case 'addComment': {
      const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return null;
      }
      const comment = { id: ctx.store.allocateId(), body: String(input.body ?? ''), user: ctx.store.viewer.login, createdAt: ctx.store.nowIso() };
      found.issue.comments.push(comment);
      found.issue.updatedAt = ctx.store.nowIso();
      const node = applySelections(ctx, 'IssueComment', {
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`),
        databaseId: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        url: `${ctx.origin}/${found.repo.owner}/${found.repo.name}/issues/${found.issue.number}#issuecomment-${comment.id}`,
        __author: comment.user,
      }, selections?.find((sel) => sel.name === 'commentEdge')?.selections?.find((sel) => sel.name === 'node')?.selections, resolveCommentField);
      return { commentEdge: { node } };
    }
    default:
      return unknownField(ctx, 'Mutation', field);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function executeOperation(store: Store, origin: string, operation: Operation, fragments: Map<string, Fragment>, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecCtx = { store, origin, variables, fragments, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragmentSpread' || selection.kind === 'inlineFragment') continue;
    const key = selection.alias ?? selection.name;
    const resolved =
      operation.type === 'mutation'
        ? resolveMutationField(ctx, selection.name, selection.arguments, selection.selections)
        : resolveRootField(ctx, selection.name, selection.arguments, selection.selections);
    if (resolved === undefined) {
      data[key] = null;
    } else if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved) && selection.selections) {
      // Mutation payload objects (createIssue etc.) select subfields of the
      // payload; the resolver already applied them, so keep as-is.
      data[key] = resolved;
    } else {
      data[key] = resolved;
    }
  }
  const result: { data: Record<string, unknown> | null; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, origin: string, body: unknown): { status: number; body: unknown } {
  const requests = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const request of requests) {
    if (typeof request !== 'object' || request === null) {
      responses.push({ errors: [{ message: 'Request must be an object' }] });
      continue;
    }
    const { query, variables } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') {
      responses.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    let parsed: { operations: Operation[]; fragments: Map<string, Fragment> };
    try {
      parsed = new Parser(query).parseDocument();
    } catch (error) {
      responses.push({ errors: [{ message: `Syntax Error: ${error instanceof Error ? error.message : 'parse failed'}` }] });
      continue;
    }
    if (parsed.operations.length === 0) {
      responses.push({ errors: [{ message: 'No operation found' }] });
      continue;
    }
    const operation = parsed.operations[0] as Operation;
    const vars = (variables as Record<string, unknown>) ?? {};
    // Apply variable defaults.
    for (const def of operation.variableDefinitions) {
      if (vars[def.name] === undefined && def.default) vars[def.name] = resolveValue(def.default, vars);
    }
    responses.push(executeOperation(store, origin, operation, parsed.fragments, vars));
  }
  return { status: 200, body: Array.isArray(body) ? responses : responses[0] };
}
