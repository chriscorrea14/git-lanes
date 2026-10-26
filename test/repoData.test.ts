import { afterEach, describe, expect, it } from 'vitest';
import { loadRepo, parseTrack, parseWorktrees } from '../src/git/repoData';
import { TestRepo } from './repoHelper';

let repo: TestRepo;
afterEach(() => repo?.dispose());

describe('parseTrack', () => {
  it('parses ahead/behind', () => {
    expect(parseTrack('[ahead 2, behind 1]')).toEqual({ ahead: 2, behind: 1 });
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0 });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('loadRepo', () => {
  it('loads trunk, branch commits and HEAD', async () => {
    repo = new TestRepo();
    const m1 = repo.commit('m1');
    const m2 = repo.commit('m2');
    repo.checkout('-b', 'feat/x', m1);
    const a = repo.commit('a');
    const b = repo.commit('b');
    repo.checkout('main');
    const m3 = repo.commit('m3');

    const g = await loadRepo(repo.git, { trunkCommits: 50 });
    expect(g.trunk.name).toBe('main');
    expect(g.trunk.commits).toEqual([m3, m2, m1]);
    expect(g.trunk.hasMore).toBe(false);
    expect(g.branches.map((x) => x.name)).toEqual(['feat/x']);
    expect(g.commits[b].parents).toEqual([a]);
    expect(g.commits[a].parents).toEqual([m1]);
    expect(g.commits[a].subject).toBe('a');
    expect(g.head).toEqual({ branch: 'main', sha: m3 });
    expect(g.attach).toEqual({});
  });

  it('extends the trunk window to reach old fork points', async () => {
    repo = new TestRepo();
    const base = repo.commit('base');
    for (let i = 0; i < 10; i++) repo.commit(`m${i}`);
    repo.checkout('-b', 'old', base);
    repo.commit('o1');
    repo.checkout('main');

    const g = await loadRepo(repo.git, { trunkCommits: 3 });
    expect(g.trunk.commits).toContain(base);
  });

  it('marks hasMore when trunk is truncated', async () => {
    repo = new TestRepo();
    for (let i = 0; i < 10; i++) repo.commit(`m${i}`);
    const g = await loadRepo(repo.git, { trunkCommits: 4 });
    expect(g.trunk.commits).toHaveLength(4);
    expect(g.trunk.hasMore).toBe(true);
  });

  it('attaches fork points that are off the first-parent chain to the merge commit', async () => {
    repo = new TestRepo();
    const m1 = repo.commit('m1');
    repo.checkout('-b', 'side');
    const s1 = repo.commit('s1');
    repo.checkout('main');
    repo.commit('m2');
    const merge = repo.merge('side', 'merge side');
    repo.sh('branch', '-D', 'side');
    repo.checkout('-b', 'feat', s1);
    repo.commit('f1');
    repo.checkout('main');

    const g = await loadRepo(repo.git, { trunkCommits: 50 });
    expect(g.attach[s1]).toBe(merge);
    expect(g.trunk.commits).toContain(m1);
  });

  it('reports upstream sha and ahead/behind', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.sh('remote', 'add', 'origin', '/nonexistent');
    repo.sh('update-ref', 'refs/remotes/origin/feat', f1);
    repo.sh('branch', '--set-upstream-to=origin/feat');
    repo.commit('f2');
    repo.checkout('main');

    const g = await loadRepo(repo.git, { trunkCommits: 50 });
    const feat = g.branches.find((b) => b.name === 'feat')!;
    expect(feat.upstream).toBe('origin/feat');
    expect(feat.upstreamSha).toBe(f1);
    expect(feat.ahead).toBe(1);
    expect(feat.behind).toBe(0);
  });

  it('uses a same-named remote branch when no upstream is configured', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.sh('remote', 'add', 'origin', '/nonexistent');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.sh('update-ref', 'refs/remotes/origin/feat', f1); // as if pushed without --set-upstream
    repo.commit('f2');
    repo.checkout('-b', 'local-only');
    repo.commit('l1');
    repo.checkout('main');
    const g = await loadRepo(repo.git, { trunkCommits: 50 });
    expect(g.branches.find((b) => b.name === 'feat')).toMatchObject({
      upstream: 'origin/feat',
      upstreamSha: f1,
      untracked: true,
      ahead: 1,
      behind: 0,
    });
    expect(g.branches.find((b) => b.name === 'local-only')!.upstream).toBeUndefined();
  });

  it('marks branches checked out in other worktrees', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.sh('branch', 'feat');
    repo.sh('branch', 'other');
    const wt = `${repo.dir}-wt`;
    repo.sh('worktree', 'add', '-q', wt, 'feat');
    try {
      const g = await loadRepo(repo.git, { trunkCommits: 50 });
      const { realpathSync } = await import('node:fs');
      expect(realpathSync(g.branches.find((b) => b.name === 'feat')!.worktree!)).toBe(realpathSync(wt));
      expect(g.branches.find((b) => b.name === 'other')!.worktree).toBeUndefined();
      expect(g.trunk.worktree).toBeUndefined(); // main is checked out here, not elsewhere
    } finally {
      repo.sh('worktree', 'remove', '--force', wt);
    }
  });

  it('parses worktree list output', () => {
    const out = 'worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nHEAD 3\nbranch refs/heads/x/y\n';
    expect([...parseWorktrees(out)]).toEqual([
      ['main', '/a'],
      ['x/y', '/c'],
    ]);
  });

  it('adds a detached HEAD pseudo-branch', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('--detach');
    const d = repo.commit('d1');
    const g = await loadRepo(repo.git, { trunkCommits: 50 });
    expect(g.head.branch).toBeUndefined();
    expect(g.branches).toContainEqual(expect.objectContaining({ name: 'HEAD', tip: d, detached: true }));
  });
});
