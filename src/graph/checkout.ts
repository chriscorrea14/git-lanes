import type { RawGraph } from '../types';
import type { Layout } from './layout';

/**
 * What double-clicking a commit checks out: a local branch whose tip it is (preferring the branch
 * whose lane it sits in), otherwise the commit itself as a detached HEAD.
 */
export function checkoutTarget(raw: RawGraph, layout: Layout, sha: string): string {
  const local = new Set(raw.branches.filter((b) => !b.detached).map((b) => b.name));
  if (!raw.trunk.remote) local.add(raw.trunk.name);
  const tips = (layout.refs[sha] ?? []).filter((r) => r.kind === 'branch' && local.has(r.name)).map((r) => r.name);
  // refs[] also attaches tips of off-chain commits to the commit that merged them; only exact tips count.
  const exact = tips.filter((name) => (name === raw.trunk.name ? raw.trunk.tip : raw.branches.find((b) => b.name === name)?.tip) === sha);
  const node = layout.nodeBySha.get(sha);
  const laneName = node ? layout.lanes[node.lane].name : undefined;
  if (laneName && exact.includes(laneName)) return laneName;
  return exact[0] ?? sha;
}
