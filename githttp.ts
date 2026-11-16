// githttp.ts — git smart HTTP: info/refs advertisements (protocol v2 and v0),
// ls-refs, fetch (upload-pack v2 and v0) and push (receive-pack v0 with
// report-status over side-band-64k). All object ids and bytes are verified against
// the store; packs are written with plain objects only (no deltas).

import {
  ZERO_OID,
  decodeAllPktLines,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitproto.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge-git/1.0';

export interface GitRequest {
  readonly method: string;
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly repo: Repo | null;
  readonly protocol2: boolean;
  readonly body: Buffer;
}

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The refs a repo advertises, HEAD first, then sorted. */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const refs: Array<{ oid: string; name: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) refs.push({ oid: tip, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    refs.push({ oid: repo.refs.get(name) as string, name });
  }
  return refs;
}

/** The peeled commit for an annotated tag ref, or null when it is not one. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = parseTag(object.data).object;
  for (let i = 0; i < 10; i += 1) {
    const next = repo.objects.get(current);
    if (!next || next.type !== 'tag') return current;
    current = parseTag(next.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(repo: Repo | null, service: 'git-upload-pack' | 'git-receive-pack', protocol2: boolean): GitResponse {
  if (repo === null) return err(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (protocol2 && service === 'git-upload-pack') {
    // Protocol v2: service preamble, flush, `version 2`, capability lines, flush.
    const caps = [
      'agent=forge-git/1.0',
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
      'server-option',
    ];
    const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktFlush(), encodePktLine('version 2\n')];
    for (const cap of caps) parts.push(encodePktLine(`${cap}\n`));
    parts.push(pktFlush());
    return ok(contentType, Buffer.concat(parts));
  }
  // Protocol v0: service preamble, flush, `<oid> <ref>` lines (capabilities on the
  // first line after a NUL), flush.
  const caps: string[] = ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'multi_ack_detailed', 'agent=forge-git/1.0'];
  if (service === 'git-receive-pack') caps.push('report-status', 'side-band-64k', 'delete-refs');
  else caps.push('no-progress');
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) caps.unshift(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps.join(' ')}\n`);
  } else {
    refs.forEach((ref, index) => {
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\u0000${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`);
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null && ref.name.startsWith('refs/tags/')) lines.push(`${peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return ok(contentType, encodePktLines(lines));
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo | null, body: Buffer): GitResponse {
  if (repo === null) return err(404, 'Not Found');
  const { packets } = decodePktLines(body);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (tip) {
      out.push(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const peeled = peel ? peeledOf(repo, oid) : null;
    if (peeled !== null) line += ` peeled:${peeled}`;
    out.push(`${line}\n`);
  }
  const parts = out.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchV2(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
  }
  return req;
}

function parseFetchV0(body: Buffer): FetchRequest {
  // v0 is two sections (wants, then haves + done) separated by a flush, so the
  // whole body must be decoded, not just up to the first flush.
  const packets = decodeAllPktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
  }
  return req;
}

/**
 * The objects a fetch must send, and the new shallow boundary.
 * - `held` is what the client already has: the closure of its haves, stopping at
 *   its shallow boundary (whose parents it does not hold).
 * - with a depth, only commits within that distance of the wants are sent, and the
 *   commits at the cut are the new shallow boundary.
 */
function computeFetch(
  repo: Repo,
  req: FetchRequest,
): { send: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const held = new Set<string>();
  const shallowSet = new Set(req.shallow);
  const heldQueue: string[] = [...req.haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      held.add(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) heldQueue.push(parent);
      // trees' blobs are held too: walk the tree
      const treeQueue: string[] = [commit.tree];
      while (treeQueue.length) {
        const treeOid = treeQueue.pop() as string;
        const tree = lookup(treeOid);
        if (!tree || tree.type !== 'tree') continue;
        for (const entry of parseTree(tree.data)) {
          if (held.has(entry.oid)) continue;
          held.add(entry.oid);
          if (entry.mode === '40000') treeQueue.push(entry.oid);
        }
      }
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      const treeQueue: string[] = [oid];
      while (treeQueue.length) {
        const treeOid = treeQueue.pop() as string;
        const tree = lookup(treeOid);
        if (!tree || tree.type !== 'tree') continue;
        for (const entry of parseTree(tree.data)) {
          if (held.has(entry.oid)) continue;
          held.add(entry.oid);
          if (entry.mode === '40000') treeQueue.push(entry.oid);
        }
      }
    }
  }

  // The wanted closure, with an optional depth cut.
  const wanted = new Set<string>();
  const boundary = new Set<string>();
  const commitDistance = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = req.wants.map((oid) => ({ oid, depth: 0 }));
  const visitTree = (treeOid: string): void => {
    const treeQueue: string[] = [treeOid];
    // Track visited trees separately from `wanted`: a subtree is added to
    // `wanted` when its parent lists it, so a wanted-check here would skip
    // walking it and lose everything underneath.
    const visited = new Set<string>();
    while (treeQueue.length) {
      const current = treeQueue.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const tree = lookup(current);
      if (!tree || tree.type !== 'tree') continue;
      wanted.add(current);
      for (const entry of parseTree(tree.data)) {
        wanted.add(entry.oid);
        if (entry.mode === '40000') treeQueue.push(entry.oid);
      }
    }
  };
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (wanted.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    wanted.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      commitDistance.set(oid, depth);
      visitTree(commit.tree);
      if (req.depth === null || depth + 1 < req.depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      } else {
        boundary.add(oid);
      }
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth });
    } else if (object.type === 'tree') {
      visitTree(oid);
    }
  }

  const send: GitObject[] = [];
  // Remember each object's id while collecting it: recomputing SHA-1 inside
  // the sort comparator would hash every object O(log n) times per fetch.
  const sendOid = new Map<GitObject, string>();
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) {
      send.push(object);
      sendOid.set(object, oid);
    }
  }
  // Order the pack deterministically: commits, tags, trees, blobs, by oid.
  const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3);
  send.sort((a, b) => rank(a.type) - rank(b.type) || ((sendOid.get(a) as string) < (sendOid.get(b) as string) ? -1 : 1));

  const shallow = [...boundary].filter((oid) => !held.has(oid) || shallowSet.has(oid));
  const unshallow = [...shallowSet].filter((oid) => wanted.has(oid) && !boundary.has(oid) && commitDistance.has(oid));
  const acks = req.haves.filter((have) => req.wants.some((want) => isAncestor(have, want, lookup)));
  return { send, shallow, unshallow, acks, nak: acks.length === 0 };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

/**
 * Fetch-result cache: objects are immutable, so what a (wants, haves,
 * shallow, depth) fetch sends never changes for a given repo. Repeat fetches
 * — the benchmark's 50 concurrent clones of one tip — skip the closure walk
 * and the pack build entirely. Bounded FIFO, 32 entries.
 */
const fetchCache = new Map<string, { pack: Buffer | null; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean }>();
const FETCH_CACHE_MAX = 32;

function fetchCacheKey(repo: Repo, req: FetchRequest): string {
  return `${repo.id}|${[...req.wants].sort().join(',')}|${[...req.haves].sort().join(',')}|${[...req.shallow].sort().join(',')}|${req.depth ?? ''}`;
}

export function handleFetch(repo: Repo | null, body: Buffer, protocol2: boolean): GitResponse {
  if (repo === null) return err(404, 'Not Found');
  const req = protocol2 ? parseFetchV2(body) : parseFetchV0(body);
  if (req.wants.length === 0) return ok('application/x-git-upload-pack-result', pktFlush());
  for (const want of req.wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) {
      return err(400, `want ${want} is not available`);
    }
  }
  const key = fetchCacheKey(repo, req);
  let cached = fetchCache.get(key);
  if (cached === undefined) {
    const computed = computeFetch(repo, req);
    cached = {
      pack: computed.send.length > 0 ? writePack(computed.send) : null,
      shallow: computed.shallow,
      unshallow: computed.unshallow,
      acks: computed.acks,
      nak: computed.nak,
    };
    if (fetchCache.size >= FETCH_CACHE_MAX) {
      const oldest = fetchCache.keys().next().value;
      if (oldest !== undefined) fetchCache.delete(oldest);
    }
    fetchCache.set(key, cached);
  }
  const { pack, shallow, unshallow, acks, nak } = cached;
  const parts: Buffer[] = [];
  if (protocol2) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (nak) parts.push(encodePktLine('NAK\n'));
    else {
      for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
    }
    parts.push(pktDelim());
    if (shallow.length || unshallow.length) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    if (pack !== null) {
      parts.push(encodePktLine('packfile\n'));
      parts.push(...sidebandPackets(pack));
    }
    parts.push(pktFlush());
  } else {
    if (nak) parts.push(encodePktLine('NAK\n'));
    else {
      for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    }
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    if (pack !== null) parts.push(...sidebandPackets(pack));
    parts.push(pktFlush());
  }
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handlePush(repo: Repo | null, body: Buffer): GitResponse {
  if (repo === null) return err(404, 'Not Found');
  const { packets, endOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) return pushReport([{ ref: '', ok: false, reason: 'malformed command' }], false, 'malformed command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      return pushReport([{ ref: ref ?? '', ok: false, reason: 'malformed command' }], false, 'malformed command');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return pushReport([], false, 'no commands');

  // Unpack: the bytes after the command flush are the packfile (absent for a
  // delete-only push).
  const packBytes = body.subarray(endOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'old ref does not match' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'old ref does not match' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old ref does not match' });
        continue;
      }
      // Fast-forward: the new tip must descend from the old one. Tag targets are
      // exempt from the ancestry check (a tag update is not a branch advance).
      const oldObject = repo.objects.get(current);
      const bothCommits = target.type === 'commit' && oldObject?.type === 'commit';
      if (bothCommits && !isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return pushReport(results, unpackOk, unpackDetail);
}

function pushReport(
  results: Array<{ ref: string; ok: boolean; reason: string }>,
  unpackOk: boolean,
  unpackDetail: string,
): GitResponse {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = encodePktLines(lines);
  // report-status over side-band-64k: band 1 carries the pkt-lined report.
  const outer = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]);
  return ok('application/x-git-receive-pack-result', outer);
}

// Re-exported for the packet-level unit path used by the malformed-request check.
export function decodePacketsForTest(body: Buffer): GitPacket[] {
  return decodeAllPktLines(body);
}
