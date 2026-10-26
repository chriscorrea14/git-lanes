import { describe, expect, it } from 'vitest';
import { checkoutTarget } from '../src/graph/checkout';
import { computeLayout } from '../src/graph/layout';
import type { Branch, RawGraph } from '../src/types';

function graph(opts: { trunkRemote?: boolean; branches?: Partial<Branch>[] } = {}): RawGraph {
  const c = (sha: string, parents: string[]) => ({ sha, parents, author: '', email: '', date: 0, subject: sha, body: '' });
  return {
    trunk: { name: opts.trunkRemote ? 'origin/main' : 'main', tip: 'm2', ahead: 0, behind: 0, commits: ['m2', 'm1'], hasMore: false, remote: !!opts.trunkRemote },
    branches: (opts.branches ?? [{ name: 'feat', tip: 'b' }]).map((b) => ({ ahead: 0, behind: 0, ...b }) as Branch),
    head: { branch: 'main', sha: 'm2' },
    commits: { m2: c('m2', ['m1']), m1: c('m1', []), b: c('b', ['a']), a: c('a', ['m1']) },
    attach: {},
    remotes: [],
  };
}
const target = (raw: RawGraph, sha: string) => checkoutTarget(raw, computeLayout(raw, { alignment: 'top' }), sha);

describe('checkoutTarget', () => {
  it('checks out the branch at its tip', () => {
    expect(target(graph(), 'b')).toBe('feat');
  });

  it('detaches at commits that are not a branch tip', () => {
    expect(target(graph(), 'a')).toBe('a');
    expect(target(graph(), 'm1')).toBe('m1');
  });

  it('checks out local trunk at its tip, but never a remote trunk ref', () => {
    expect(target(graph(), 'm2')).toBe('main');
    expect(target(graph({ trunkRemote: true }), 'm2')).toBe('m2');
    const withLocalMain = graph({ trunkRemote: true, branches: [{ name: 'feat', tip: 'b' }, { name: 'main', tip: 'm2' }] });
    expect(target(withLocalMain, 'm2')).toBe('main');
  });

  it('prefers the lane branch when several branches share a tip', () => {
    const raw = graph({ branches: [{ name: 'feat', tip: 'b' }, { name: 'zz-alias', tip: 'b' }] });
    expect(target(raw, 'b')).toBe('feat');
  });
});
