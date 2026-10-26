import type { Layout } from '../graph/layout';
import type { RawGraph } from '../types';

export interface RebasePlan {
  branch: string;
  /** Commits reachable from this are not replayed (the `<upstream>` argument). */
  upstream: string;
  target: string;
  laneCommits: number;
  warnings: string[];
}

/** Lane index of a commit if that lane can be dragged (a named, non-trunk branch). */
export function draggableLane(layout: Layout, sha: string): number | undefined {
  const node = layout.nodeBySha.get(sha);
  if (!node) return undefined;
  return layout.lanes[node.lane].kind === 'branch' ? node.lane : undefined;
}

/** Commits a lane may not be dropped onto: its own commits, their descendants, and its current base. */
export function invalidTargets(layout: Layout, lane: number): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of layout.edges) {
    if (!children.has(e.to)) children.set(e.to, []);
    children.get(e.to)!.push(e.from);
  }
  const invalid = new Set<string>();
  const stack = [...layout.lanes[lane].commits];
  while (stack.length) {
    const sha = stack.pop()!;
    if (invalid.has(sha)) continue;
    invalid.add(sha);
    stack.push(...(children.get(sha) ?? []));
  }
  const bottom = layout.lanes[lane].commits.at(-1)!;
  const fork = layout.edges.find((e) => e.from === bottom && e.kind === 'fork');
  if (fork) invalid.add(fork.to);
  return invalid;
}

export interface PlanContext {
  dirty: boolean;
}

export function planRebase(raw: RawGraph, layout: Layout, lane: number, target: string, ctx: PlanContext): RebasePlan {
  const l = layout.lanes[lane];
  if (l.kind !== 'branch' || !l.branch) throw new Error('Only branch lanes can be rebased.');
  if (l.branch.worktree) {
    throw new Error(`${l.branch.name} is checked out in another worktree (${l.branch.worktree}). Rebase it from there.`);
  }
  if (invalidTargets(layout, lane).has(target)) throw new Error(`Cannot rebase ${l.name} onto that commit.`);

  // Exclude everything the branch got from where it forked: the whole trunk, or the parent
  // branch for stacked branches. This keeps merged-in trunk commits from being replayed.
  const bottom = l.commits.at(-1)!;
  const forkEdge = layout.edges.find((e) => e.from === bottom && e.kind === 'fork');
  const forkLane = forkEdge ? layout.lanes[layout.nodeBySha.get(forkEdge.to)!.lane] : undefined;
  let upstream: string;
  if (!forkLane || forkLane.kind === 'trunk') upstream = raw.trunk.tip;
  else if (forkLane.branch) upstream = forkLane.branch.tip;
  else upstream = raw.commits[bottom].parents[0];

  const b = l.branch;
  const warnings: string[] = [];
  if (b.upstream && b.upstreamSha && b.ahead < l.commits.length) {
    warnings.push(`${b.name} has commits already pushed to ${b.upstream}; you will need to force-push.`);
  }
  if (raw.head.branch !== b.name) warnings.push(`This will check out ${b.name}.`);
  if (ctx.dirty) warnings.push('Uncommitted changes will be stashed and re-applied (--autostash).');
  if (l.commits.some((s) => raw.commits[s].parents.length > 1)) {
    warnings.push('Merge commits in the branch will be flattened.');
  }
  const stacked = layout.lanes.filter((other) => {
    if (other.index === lane || other.kind === 'trunk') return false;
    const ob = other.commits.at(-1)!;
    return layout.edges.some((e) => e.from === ob && e.kind === 'fork' && l.commits.includes(e.to));
  });
  if (stacked.length) {
    warnings.push(`Branches stacked on it will not move: ${stacked.map((s) => s.name ?? '(merged)').join(', ')}.`);
  }

  return { branch: b.name, upstream, target, laneCommits: l.commits.length, warnings };
}
