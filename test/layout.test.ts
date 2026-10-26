import { describe, expect, it } from 'vitest';
import { computeLayout, type Alignment, type Layout } from '../src/graph/layout';
import type { Branch, RawGraph } from '../src/types';

interface Spec {
  /** Trunk first-parent chain, newest first. Each commit's parent is the next. */
  trunk: string[];
  /** Non-trunk commits: sha -> parents. Listed newest first for dates. */
  commits?: Record<string, string[]>;
  /** Extra parents for trunk commits (merges). */
  trunkMerges?: Record<string, string[]>;
  branches?: Record<string, string | Partial<Branch>>;
  head?: string;
  attach?: Record<string, string>;
}

function graph(spec: Spec): RawGraph {
  const commits: RawGraph['commits'] = {};
  const mk = (sha: string, parents: string[], date: number) =>
    (commits[sha] = { sha, parents, author: 'a', email: 'a@x', date, subject: sha, body: '' });
  let date = 1000;
  spec.trunk.forEach((sha, i) => {
    const next = spec.trunk[i + 1];
    mk(sha, [...(next ? [next] : []), ...(spec.trunkMerges?.[sha] ?? [])], date - i);
  });
  Object.entries(spec.commits ?? {}).forEach(([sha, parents], i) => mk(sha, parents, 2000 - i));
  const branches = Object.entries(spec.branches ?? {}).map(
    ([name, b]) => ({ name, ahead: 0, behind: 0, ...(typeof b === 'string' ? { tip: b } : b) }) as Branch,
  );
  const headBranch = spec.head ?? 'main';
  const headTip = headBranch === 'main' ? spec.trunk[0] : branches.find((b) => b.name === headBranch)?.tip ?? headBranch;
  return {
    trunk: { name: 'main', tip: spec.trunk[0], ahead: 0, behind: 0, commits: spec.trunk, hasMore: false, remote: false },
    branches,
    head: { branch: branches.some((b) => b.name === headBranch) || headBranch === 'main' ? headBranch : undefined, sha: headTip },
    commits,
    attach: spec.attach ?? {},
    remotes: [],
  };
}

const at = (l: Layout, sha: string) => {
  const n = l.nodeBySha.get(sha);
  if (!n) throw new Error(`${sha} not shown`);
  return [n.lane, n.row];
};
const laneNames = (l: Layout) => l.lanes.map((x) => x.name ?? `<${x.kind}>`);
const edgeKinds = (l: Layout) => l.edges.filter((e) => e.kind !== 'lane').map((e) => `${e.from}->${e.to}:${e.kind}`).sort();

const layout = (spec: Spec, alignment: Alignment = 'top', minGap = 4) => computeLayout(graph(spec), { alignment, minGap });

describe('ownership and lanes', () => {
  it('gives each branch a lane with only its exclusive commits', () => {
    const l = layout({ trunk: ['m3', 'm2', 'm1'], commits: { b: ['a'], a: ['m1'] }, branches: { x: 'b' } });
    expect(laneNames(l)).toEqual(['main', 'x']);
    expect(l.lanes[1].commits).toEqual(['b', 'a']);
    expect(edgeKinds(l)).toEqual(['a->m1:fork']);
  });

  it('stacked branches: lower branch owns its commits, upper forks from its tip', () => {
    const l = layout({
      trunk: ['m2', 'm1'],
      commits: { d: ['c'], c: ['b'], b: ['a'], a: ['m1'] },
      branches: { y: 'd', x: 'b' },
    });
    expect(laneNames(l)).toEqual(['main', 'x', 'y']);
    expect(l.lanes[1].commits).toEqual(['b', 'a']);
    expect(l.lanes[2].commits).toEqual(['d', 'c']);
    expect(edgeKinds(l)).toEqual(['a->m1:fork', 'c->b:fork']);
  });

  it('stacked branch with a third local branch merged in', () => {
    const l = layout({
      trunk: ['m3', 'm2', 'm1'],
      commits: { M: ['d', 'z2'], d: ['c'], c: ['b'], b: ['a'], a: ['m1'], z2: ['z1'], z1: ['m2'] },
      branches: { y: 'M', x: 'b', z: 'z2' },
    });
    expect(laneNames(l)).toEqual(['main', 'x', 'y', 'z']);
    expect(l.lanes[2].commits).toEqual(['M', 'd', 'c']);
    expect(l.lanes[3].commits).toEqual(['z2', 'z1']);
    expect(edgeKinds(l)).toEqual(['M->z2:merge', 'a->m1:fork', 'c->b:fork', 'z1->m2:fork']);
    expect(l.nodeBySha.get('M')!.merge).toBe(true);
  });

  it('puts a merged-in deleted branch on an unlabeled sub-lane next to its merger', () => {
    const l = layout({
      trunk: ['m2', 'm1'],
      commits: { M: ['b', 's2'], b: ['m1'], s2: ['s1'], s1: ['m1'], q: ['m2'] },
      branches: { y: 'M', other: 'q' },
    });
    const names = laneNames(l);
    expect(names.indexOf('<merged>')).toBe(names.indexOf('y') + 1);
    expect(l.lanes.find((x) => x.kind === 'merged')!.commits).toEqual(['s2', 's1']);
  });

  it('hides merged-in side chains that are already on trunk, keeping the merge commit', () => {
    const spec: Spec = {
      trunk: ['m2', 'm1'],
      commits: { M: ['b', 's2'], b: ['m1'], s2: ['s1'], s1: ['m1'] },
      branches: { y: 'M' },
    };
    const shown = computeLayout(graph(spec), { alignment: 'top' });
    expect(shown.lanes.some((x) => x.kind === 'merged')).toBe(true);
    const hidden = computeLayout(graph(spec), { alignment: 'top', hiddenChains: new Set(['s2']) });
    expect(hidden.lanes.map((x) => x.kind)).toEqual(['trunk', 'branch']);
    expect(hidden.nodeBySha.has('s1')).toBe(false);
    expect(hidden.nodeBySha.get('M')!.merge).toBe(true);
    expect(hidden.edges.some((e) => e.kind === 'merge')).toBe(false);
    expect(hidden.foldedMerges).toEqual({ M: 's2' });
  });

  it('hides every merged-in lane when merged lanes are turned off, counting what each merge brought in', () => {
    const spec: Spec = {
      trunk: ['m2', 'm1'],
      commits: { M: ['c', 's2'], c: ['b'], b: ['m1'], s2: ['s1'], s1: ['m1'], q: ['m2'] },
      branches: { y: 'M', other: 'q' },
    };
    const l = computeLayout(graph(spec), { alignment: 'top', hideMergedLanes: true });
    expect(l.lanes.map((x) => x.kind)).toEqual(['trunk', 'branch', 'branch']);
    expect(l.foldedMerges).toEqual({ M: 's2' });
    expect(l.foldedSizes).toEqual({ s2: 2 });
    expect(l.columnCount).toBe(3);
  });

  it('packs non-overlapping merged side-chains into one column', () => {
    // y merges two deleted side branches at different heights: s (near the top) and t (lower).
    const l = layout({
      trunk: ['m2', 'm1'],
      commits: { M1: ['M2', 's1'], M2: ['b', 't1'], b: ['a'], a: ['m1'], s1: ['M2'], t1: ['a'] },
      branches: { y: 'M1' },
    });
    const merged = l.lanes.filter((x) => x.kind === 'merged');
    expect(merged).toHaveLength(2);
    expect(merged[0].column).toBe(merged[1].column);
    expect(l.columnCount).toBe(3);
  });

  it('gives overlapping merged side-chains separate columns', () => {
    const l = layout({
      trunk: ['m2', 'm1'],
      commits: { M1: ['M2', 's2'], M2: ['b', 't1'], b: ['m1'], s2: ['s1'], s1: ['m1'], t1: ['m1'] },
      branches: { y: 'M1' },
    });
    const merged = l.lanes.filter((x) => x.kind === 'merged');
    expect(new Set(merged.map((m) => m.column)).size).toBe(2);
  });

  it('shows fully merged branches only as refs', () => {
    const l = layout({ trunk: ['m2', 'm1'], branches: { old: 'm1' } });
    expect(laneNames(l)).toEqual(['main']);
    expect(l.refs['m1']).toContainEqual({ name: 'old', kind: 'branch' });
  });

  it('attaches forks off the first-parent chain to the merge commit', () => {
    const l = layout({
      trunk: ['m3', 'mm', 'm1'],
      trunkMerges: { mm: ['s1'] },
      commits: { f: ['s1'] },
      branches: { feat: 'f' },
      attach: { s1: 'mm' },
    });
    expect(edgeKinds(l)).toEqual(['f->mm:fork']);
  });

  it('orders unrelated top-level lanes by newest tip', () => {
    const l = layout({ trunk: ['m2', 'm1'], commits: { new1: ['m1'], old1: ['m1'] }, branches: { old: 'old1', new: 'new1' } });
    expect(laneNames(l)).toEqual(['main', 'new', 'old']);
  });

  it('marks the HEAD lane and HEAD first-parent path', () => {
    const l = layout({ trunk: ['m2', 'm1'], commits: { b: ['a'], a: ['m1'] }, branches: { x: 'b' }, head: 'x' });
    expect(l.lanes.find((x) => x.isHead)!.name).toBe('x');
    expect([...l.headPath]).toEqual(['b', 'a', 'm1']);
  });
});

describe('row packing', () => {
  const spec: Spec = {
    trunk: ['m4', 'm3', 'm2', 'm1'],
    commits: { b: ['a'], a: ['m1'] },
    branches: { x: 'b' },
  };

  it('top: branch tips share row 0 with trunk tip', () => {
    const l = layout(spec, 'top');
    expect(at(l, 'm4')).toEqual([0, 0]);
    expect(at(l, 'b')).toEqual([1, 0]);
    expect(at(l, 'a')).toEqual([1, 1]);
    expect(at(l, 'm1')).toEqual([0, 3]);
  });

  it('forkPoint: branch sits right above its fork point', () => {
    const l = layout(spec, 'forkPoint');
    expect(at(l, 'm1')).toEqual([0, 3]);
    expect(at(l, 'a')).toEqual([1, 2]);
    expect(at(l, 'b')).toEqual([1, 1]);
    expect(at(l, 'm4')).toEqual([0, 0]);
  });

  it('never puts a parent at or above its child', () => {
    for (const alignment of ['top', 'forkPoint'] as const) {
      const l = layout(
        {
          trunk: ['m3', 'm2', 'm1'],
          commits: { M: ['d', 'z2'], d: ['c'], c: ['b'], b: ['a'], a: ['m1'], z2: ['z1'], z1: ['m2'] },
          branches: { y: 'M', x: 'b', z: 'z2' },
        },
        alignment,
      );
      for (const e of l.edges) expect(l.nodeBySha.get(e.to)!.row).toBeGreaterThan(l.nodeBySha.get(e.from)!.row);
    }
  });
});

describe('gaps', () => {
  const trunk = Array.from({ length: 12 }, (_, i) => `m${12 - i}`); // m12..m1
  const spec: Spec = { trunk, commits: { a: ['m1'] }, branches: { x: 'a' } };

  it('collapses long idle trunk runs, keeping context rows', () => {
    const l = layout(spec, 'forkPoint');
    expect(l.gaps).toHaveLength(1);
    // m12 is the tip and m2 shares a row with a; m11..m3 are boring -> m11 and m3 stay.
    expect(l.gaps[0].hidden).toEqual(['m10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4']);
    expect(l.nodeBySha.has('m10')).toBe(false);
    expect(l.edges).toContainEqual({ from: 'm11', to: 'm3', kind: 'lane' });
    expect(l.rowCount).toBe(12 - 7 + 1);
  });

  it('expands a gap on request', () => {
    const raw = graph(spec);
    const l = computeLayout(raw, { alignment: 'forkPoint', expandedGaps: new Set(['m10']) });
    expect(l.gaps).toHaveLength(0);
    expect(l.nodeBySha.has('m10')).toBe(true);
  });

  it('does not collapse rows shared with other lanes', () => {
    const l = layout(spec, 'top');
    // In top mode, a sits on row 0 next to m12; rows 1..10 are trunk-only.
    expect(l.gaps).toHaveLength(1);
    expect(l.nodeBySha.has('a')).toBe(true);
  });
});

describe('upstream markers', () => {
  it('draws every commit of a branch with no remote copy as unpushed', () => {
    const l = layout({ trunk: ['m2', 'm1'], commits: { b: ['a'], a: ['m1'] }, branches: { x: 'b' } });
    expect(l.nodes.filter((n) => n.unpushed).map((n) => n.sha).sort()).toEqual(['a', 'b']);
    expect(l.nodeBySha.get('m2')!.unpushed).toBe(false); // trunk is never marked
  });

  it('labels the upstream commit and marks unpushed commits', () => {
    const l = layout({
      trunk: ['m2', 'm1'],
      commits: { c: ['b'], b: ['a'], a: ['m1'] },
      branches: { x: { tip: 'c', upstream: 'origin/x', upstreamSha: 'a', ahead: 2 } },
    });
    expect(l.refs['a']).toContainEqual({ name: 'origin/x', kind: 'remote' });
    expect(l.nodes.filter((n) => n.unpushed).map((n) => n.sha).sort()).toEqual(['b', 'c']);
  });
});
