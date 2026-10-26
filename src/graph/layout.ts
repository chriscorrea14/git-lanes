import type { Branch, RawGraph } from '../types';

export type Alignment = 'top' | 'forkPoint';

export interface Lane {
  index: number;
  kind: 'trunk' | 'branch' | 'merged' | 'detached';
  /** Branch name; undefined for merged sub-lanes. */
  name?: string;
  branch?: Branch;
  /** Commits owned by this lane, newest first (a single first-parent chain). */
  commits: string[];
  isHead: boolean;
  /** Horizontal position. Merged side-chains may share a column. */
  column: number;
}

export interface LayoutNode {
  sha: string;
  lane: number;
  column: number;
  row: number;
  unpushed: boolean;
  merge: boolean;
}

export type EdgeKind = 'lane' | 'fork' | 'merge';

export interface LayoutEdge {
  /** Child commit. */
  from: string;
  /** Parent commit (or the trunk commit an off-chain parent is attached to). */
  to: string;
  kind: EdgeKind;
}

export interface Gap {
  /** Display row the gap occupies. */
  row: number;
  /** Stable key (first hidden sha) used to expand it. */
  key: string;
  hidden: string[];
}

export interface RefLabel {
  name: string;
  kind: 'branch' | 'remote' | 'head';
}

export interface Layout {
  lanes: Lane[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  gaps: Gap[];
  rowCount: number;
  columnCount: number;
  /** Refs pointing at each shown commit. */
  refs: Record<string, RefLabel[]>;
  /** Shown commits on HEAD's first-parent chain. */
  headPath: Set<string>;
  /** Merge commit -> top of the merged-in side chain that was hidden. */
  foldedMerges: Record<string, string>;
  /** Hidden side-chain top -> number of commits in it (counting nested merged-in chains). */
  foldedSizes: Record<string, number>;
  nodeBySha: Map<string, LayoutNode>;
}

export interface LayoutOptions {
  alignment: Alignment;
  /** Tops of merged-in side chains not to draw (their changes are already on trunk). */
  hiddenChains?: Set<string>;
  /** Don't draw any merged-in side chains. */
  hideMergedLanes?: boolean;
  expandedGaps?: Set<string>;
  /** Minimum hidden rows for a gap to be collapsed. */
  minGap?: number;
}

/** Number of non-trunk commits reachable from each branch tip. */
function exclusiveCounts(raw: RawGraph, trunkSet: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of raw.branches) {
    const seen = new Set<string>();
    const stack = [b.tip];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha) || trunkSet.has(sha) || !raw.commits[sha]) continue;
      seen.add(sha);
      stack.push(...raw.commits[sha].parents);
    }
    counts.set(b.name, seen.size);
  }
  return counts;
}

export function computeLayout(raw: RawGraph, opts: LayoutOptions): Layout {
  const trunkSet = new Set(raw.trunk.commits);
  const isBranchCommit = (sha: string) => !!raw.commits[sha] && !trunkSet.has(sha);

  // --- Ownership: each lane is one first-parent chain. ---
  const lanes: Lane[] = [
    { index: 0, kind: 'trunk', name: raw.trunk.name, branch: raw.trunk, commits: [...raw.trunk.commits], isHead: false, column: 0 },
  ];
  const owner = new Map<string, number>();
  raw.trunk.commits.forEach((sha) => owner.set(sha, 0));

  const counts = exclusiveCounts(raw, trunkSet);
  const ordered = [...raw.branches].sort(
    (a, b) => counts.get(a.name)! - counts.get(b.name)! || a.name.localeCompare(b.name),
  );
  const claimChain = (start: string, lane: Lane) => {
    let sha: string | undefined = start;
    while (sha && isBranchCommit(sha) && !owner.has(sha)) {
      owner.set(sha, lane.index);
      lane.commits.push(sha);
      sha = raw.commits[sha].parents[0];
    }
  };
  for (const b of ordered) {
    if (!isBranchCommit(b.tip) || owner.has(b.tip)) continue;
    const lane: Lane = {
      index: lanes.length,
      kind: b.detached ? 'detached' : 'branch',
      name: b.name,
      branch: b,
      commits: [],
      isHead: false,
      column: 0,
    };
    lanes.push(lane);
    claimChain(b.tip, lane);
  }
  // Commits only reachable through a merge's second parent get unlabeled sub-lanes.
  const mergedInto = new Map<number, number>();
  const foldedMerges: Record<string, string> = {};
  const foldedSizes: Record<string, number> = {};
  // Commits reachable from a hidden chain top that no lane owns (the chain and anything merged into it).
  const countHidden = (top: string) => {
    const seen = new Set<string>();
    const stack = [top];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c) || !isBranchCommit(c) || owner.has(c)) continue;
      seen.add(c);
      stack.push(...raw.commits[c].parents);
    }
    return seen.size;
  };
  for (let i = 1; i < lanes.length; i++) {
    for (const sha of lanes[i].commits) {
      for (const p of raw.commits[sha].parents.slice(1)) {
        if (!isBranchCommit(p) || owner.has(p)) continue;
        if (opts.hideMergedLanes || opts.hiddenChains?.has(p)) {
          foldedMerges[sha] = p;
          foldedSizes[p] ??= countHidden(p);
          continue;
        }
        const lane: Lane = { index: lanes.length, kind: 'merged', commits: [], isHead: false, column: 0 };
        lanes.push(lane);
        mergedInto.set(lane.index, i);
        claimChain(p, lane);
      }
    }
  }

  // --- Edges. ---
  const resolve = (sha: string): string | undefined =>
    owner.has(sha) ? sha : raw.attach[sha] && owner.has(raw.attach[sha]) ? raw.attach[sha] : undefined;
  const edges: LayoutEdge[] = [];
  for (let i = 0; i + 1 < raw.trunk.commits.length; i++) {
    edges.push({ from: raw.trunk.commits[i], to: raw.trunk.commits[i + 1], kind: 'lane' });
  }
  for (const lane of lanes.slice(1)) {
    for (const sha of lane.commits) {
      raw.commits[sha].parents.forEach((p, i) => {
        const to = resolve(p);
        if (!to) return;
        const kind: EdgeKind = i > 0 ? 'merge' : owner.get(to) === lane.index ? 'lane' : 'fork';
        edges.push({ from: sha, to, kind });
      });
    }
  }

  // --- Lane order: depth-first clusters so related lanes sit side by side. ---
  const parentLane = new Map<number, number>();
  for (const lane of lanes.slice(1)) {
    const bottom = lane.commits[lane.commits.length - 1];
    const fork = edges.find((e) => e.from === bottom && e.kind === 'fork');
    const forkOwner = fork ? owner.get(fork.to)! : 0;
    let parent = forkOwner;
    if (mergedInto.has(lane.index)) parent = mergedInto.get(lane.index)!;
    else if (forkOwner === 0) {
      const mergeEdge = edges.find((e) => e.kind === 'merge' && owner.get(e.to) === lane.index && owner.get(e.from) !== 0);
      if (mergeEdge) parent = owner.get(mergeEdge.from)!;
    }
    parentLane.set(lane.index, parent);
  }
  // Break cycles (criss-cross merges) by re-rooting at trunk.
  for (const lane of lanes.slice(1)) {
    const seen = new Set<number>([lane.index]);
    let p = parentLane.get(lane.index)!;
    while (p !== 0) {
      if (seen.has(p)) {
        parentLane.set(lane.index, 0);
        break;
      }
      seen.add(p);
      p = parentLane.get(p)!;
    }
  }
  const tipDate = (l: Lane) => raw.commits[l.commits[0]]?.date ?? 0;
  const order: number[] = [];
  const visit = (idx: number) => {
    order.push(idx);
    lanes
      .filter((l) => l.index !== 0 && parentLane.get(l.index) === idx)
      .sort((a, b) => tipDate(b) - tipDate(a) || a.index - b.index)
      .forEach((l) => visit(l.index));
  };
  visit(0);

  // --- HEAD. ---
  const headLane = lanes.find((l) => (raw.head.branch ? l.name === raw.head.branch : l.kind === 'detached'));
  if (headLane) headLane.isHead = true;
  const headPath = new Set<string>();
  for (let sha: string | undefined = resolve(raw.head.sha); sha; ) {
    headPath.add(sha);
    const first = raw.commits[sha]?.parents[0];
    sha = first ? resolve(first) : undefined;
  }

  // --- Rows. ---
  const shas = [...owner.keys()];
  const children = new Map<string, string[]>(shas.map((s) => [s, []]));
  const parents = new Map<string, string[]>(shas.map((s) => [s, []]));
  for (const e of edges) {
    children.get(e.to)!.push(e.from);
    parents.get(e.from)!.push(e.to);
  }
  const topo = topoOrder(shas, children, parents);
  const rawRow = new Map<string, number>();
  if (opts.alignment === 'top') {
    for (const sha of topo) {
      rawRow.set(sha, Math.max(-1, ...children.get(sha)!.map((c) => rawRow.get(c)!)) + 1);
    }
  } else {
    const depth = new Map<string, number>();
    for (const sha of [...topo].reverse()) {
      depth.set(sha, Math.max(-1, ...parents.get(sha)!.map((p) => depth.get(p)!)) + 1);
    }
    const max = Math.max(0, ...depth.values());
    for (const [sha, d] of depth) rawRow.set(sha, max - d);
  }

  // --- Columns: named lanes get their own column in cluster order. Merged side-chains are packed
  // into shared columns at the end of their cluster wherever their rows don't overlap. ---
  const reach = new Map<number, number>(); // lowest row each lane's edges run down to
  for (const e of edges) {
    const l = owner.get(e.from)!;
    reach.set(l, Math.max(reach.get(l) ?? 0, rawRow.get(e.to)! - 1));
  }
  const occupancy = (l: Lane): [number, number] => [
    rawRow.get(l.commits[0])! - 1, // the merge curve arrives in the row above the tip
    Math.max(rawRow.get(l.commits.at(-1)!)!, reach.get(l.index) ?? 0),
  ];
  let nextColumn = 0;
  let pending: Lane[] = [];
  const flush = () => {
    const cols: [number, number][][] = [];
    for (const l of pending.map((l) => ({ l, occ: occupancy(l) })).sort((a, b) => a.occ[0] - b.occ[0])) {
      const [top, bottom] = l.occ;
      let c = cols.findIndex((iv) => iv.every(([a, b]) => bottom < a || top > b));
      if (c < 0) c = cols.push([]) - 1;
      cols[c].push(l.occ);
      l.l.column = nextColumn + c;
    }
    nextColumn += cols.length;
    pending = [];
  };
  for (const idx of order) {
    const l = lanes[idx];
    if (idx !== 0 && parentLane.get(idx) === 0) flush(); // a new top-level cluster starts
    if (l.kind === 'merged') pending.push(l);
    else l.column = nextColumn++;
  }
  flush();

  // Renumber lanes left to right.
  const byColumn = [...order].sort((a, b) => lanes[a].column - lanes[b].column || order.indexOf(a) - order.indexOf(b));
  const newIndex = new Map(byColumn.map((old, i) => [old, i]));
  const sortedLanes = byColumn.map((old) => ({ ...lanes[old], index: newIndex.get(old)! }));
  for (const [sha, lane] of owner) owner.set(sha, newIndex.get(lane)!);

  // --- Refs, unpushed state. ---
  const refs: Record<string, RefLabel[]> = {};
  const addRef = (sha: string | undefined, label: RefLabel) => {
    const at = sha && resolve(sha);
    if (at && !refs[at]?.some((r) => r.name === label.name)) (refs[at] ??= []).push(label);
  };
  if (!raw.head.branch) addRef(raw.head.sha, { name: 'HEAD', kind: 'head' });
  for (const b of [raw.trunk, ...raw.branches]) {
    if (!b.detached) addRef(b.tip, { name: b.name, kind: 'branch' });
    if (b.upstream) addRef(b.upstreamSha, { name: b.upstream, kind: 'remote' });
  }
  const unpushed = new Set<string>();
  for (const lane of sortedLanes) {
    if (lane.branch?.upstream) lane.commits.slice(0, lane.branch.ahead).forEach((s) => unpushed.add(s));
    // No copy on any remote: nothing on this lane has been pushed.
    else if (lane.kind === 'branch') lane.commits.forEach((s) => unpushed.add(s));
  }

  // --- Gap collapse: long runs of rows holding only an uninteresting trunk commit. ---
  const rowCount = Math.max(-1, ...rawRow.values()) + 1;
  const byRow: string[][] = Array.from({ length: rowCount }, () => []);
  for (const [sha, r] of rawRow) byRow[r].push(sha);
  const crossLane = new Set<string>();
  for (const e of edges) if (e.kind !== 'lane') crossLane.add(e.to);
  const lastTrunk = raw.trunk.commits[raw.trunk.commits.length - 1];
  const boring = (r: number) => {
    if (byRow[r].length !== 1) return false;
    const sha = byRow[r][0];
    return (
      owner.get(sha) === 0 &&
      !crossLane.has(sha) &&
      !refs[sha] &&
      sha !== raw.trunk.commits[0] &&
      sha !== lastTrunk
    );
  };
  const minGap = opts.minGap ?? 4;
  const displayRow = new Array<number>(rowCount);
  const gaps: Gap[] = [];
  let out = 0;
  for (let r = 0; r < rowCount; ) {
    let end = r;
    while (end < rowCount && boring(end)) end++;
    // Keep one visible boring row on each side of the gap for context.
    const hiddenCount = end - r - 2;
    if (hiddenCount >= minGap && !opts.expandedGaps?.has(byRow[r + 1][0])) {
      displayRow[r] = out++;
      const hidden = [];
      for (let h = r + 1; h < end - 1; h++) {
        displayRow[h] = -1;
        hidden.push(byRow[h][0]);
      }
      gaps.push({ row: out++, key: hidden[0], hidden });
      displayRow[end - 1] = out++;
      r = end;
    } else {
      // Not collapsed (too short or expanded): emit the whole run as-is.
      for (const stop = Math.max(end, r + 1); r < stop; r++) displayRow[r] = out++;
    }
  }

  const nodes: LayoutNode[] = [];
  for (const [sha, r] of rawRow) {
    if (displayRow[r] < 0) continue;
    nodes.push({
      sha,
      lane: owner.get(sha)!,
      column: sortedLanes[owner.get(sha)!].column,
      row: displayRow[r],
      unpushed: unpushed.has(sha),
      merge: raw.commits[sha].parents.length > 1,
    });
  }
  nodes.sort((a, b) => a.row - b.row || a.lane - b.lane);
  const nodeBySha = new Map(nodes.map((n) => [n.sha, n]));

  // Edges into hidden gap rows are rerouted to the commit below the gap.
  const hiddenNext = new Map<string, string>();
  for (const g of gaps) {
    const after = raw.trunk.commits[raw.trunk.commits.indexOf(g.hidden[g.hidden.length - 1]) + 1];
    for (const h of g.hidden) hiddenNext.set(h, after);
  }
  const shownEdges = edges
    .filter((e) => nodeBySha.has(e.from))
    .map((e) => (nodeBySha.has(e.to) ? e : { ...e, to: hiddenNext.get(e.to)! }))
    .filter((e) => e.to && nodeBySha.has(e.to));

  return { lanes: sortedLanes, nodes, edges: shownEdges, gaps, rowCount: out, columnCount: nextColumn, refs, headPath, foldedMerges, foldedSizes, nodeBySha };
}

/** Kahn's algorithm, children before parents. */
function topoOrder(shas: string[], children: Map<string, string[]>, parents: Map<string, string[]>): string[] {
  const pending = new Map(shas.map((s) => [s, children.get(s)!.length]));
  const queue = shas.filter((s) => pending.get(s) === 0);
  const result: string[] = [];
  while (queue.length) {
    const sha = queue.shift()!;
    result.push(sha);
    for (const p of parents.get(sha)!) {
      const n = pending.get(p)! - 1;
      pending.set(p, n);
      if (n === 0) queue.push(p);
    }
  }
  return result;
}
