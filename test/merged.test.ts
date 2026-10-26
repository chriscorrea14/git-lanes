import { afterEach, describe, expect, it } from 'vitest';
import { loadRepo } from '../src/git/repoData';
import { MergeDetector, parseNameOnly, parsePatchIds } from '../src/git/merged';
import { TestRepo } from './repoHelper';

let repo: TestRepo;
afterEach(() => repo?.dispose());

/** main with a couple of commits and a 2-commit feature branch. */
function setup() {
  repo = new TestRepo();
  repo.commit('m1');
  repo.checkout('-b', 'feat');
  repo.commit('f1');
  repo.commit('f2', 'f1.txt', 'f1 changed again');
  repo.checkout('main');
  repo.commit('m2');
}

const detect = async () => new MergeDetector(repo.git).detect(await loadRepo(repo.git, { trunkCommits: 50 }));

describe('parsePatchIds', () => {
  it('maps commits to patch ids', () => {
    expect([...parsePatchIds('aaa 111\nbbb 222\n')]).toEqual([
      ['111', 'aaa'],
      ['222', 'bbb'],
    ]);
  });
});

describe('parseNameOnly', () => {
  it('groups file names per commit, sorted; skips commits with no files', () => {
    const out = 'commit aaa\n\nz.txt\na.txt\n\ncommit bbb\n\ncommit ccc\n\nm.txt\n';
    expect([...parseNameOnly(out)]).toEqual([
      ['aaa', 'a.txt\nz.txt'],
      ['ccc', 'm.txt'],
    ]);
  });
});

describe('MergeDetector', () => {
  it('picks up a squash merge that lands after a first check (trunk indexed incrementally)', async () => {
    setup();
    const d = new MergeDetector(repo.git);
    expect(await d.detect(await loadRepo(repo.git, { trunkCommits: 50 }))).toEqual({});
    repo.commit('m3'); // trunk moves on (like a fetch) ...
    repo.sh('merge', '--squash', 'feat'); // ... and then the branch lands
    repo.sh('commit', '-q', '-m', 'squashed feat');
    expect(await d.detect(await loadRepo(repo.git, { trunkCommits: 50 }))).toEqual({
      feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main') },
    });
  });

  it('detects a squash merge', async () => {
    setup();
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'squashed feat');
    expect(await detect()).toEqual({ feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main') } });
  });

  it('detects GitLab-style squash commit + merge commit', async () => {
    setup();
    // GitLab: squash commit on top of the merge base, then a --no-ff merge commit into main.
    const mb = repo.sh('merge-base', 'main', 'feat');
    repo.checkout('-b', 'squash-tmp', mb);
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'ENG-1: squashed');
    repo.checkout('main');
    const merge = repo.merge('squash-tmp', "Merge branch 'feat' into 'main'");
    repo.sh('branch', '-D', 'squash-tmp');
    expect(await detect()).toEqual({ feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: merge } });
  });

  it('detects a rebase merge (commits replayed one by one)', async () => {
    setup();
    repo.sh('cherry-pick', repo.rev('feat~1'), repo.rev('feat'));
    expect((await detect()).feat).toMatchObject({ how: 'rebase', trunkCommit: repo.rev('main') });
  });

  it('detects merged-in side chains whose changes were squash-merged to trunk', async () => {
    setup();
    // A colleague's branch, merged into ours, then separately squash-merged into main.
    const mb = repo.sh('merge-base', 'main', 'feat');
    repo.checkout('-b', 'side', mb);
    const s1 = repo.commit('s1');
    const s2 = repo.commit('s2');
    repo.checkout('feat');
    repo.merge('side', 'merge side into feat');
    repo.checkout('main');
    repo.sh('merge', '--squash', 'side');
    repo.sh('commit', '-q', '-m', 'squashed side');
    repo.sh('branch', '-D', 'side');
    const raw = await loadRepo(repo.git, { trunkCommits: 50 });
    const d = new MergeDetector(repo.git);
    expect(await d.detectChains(raw, [{ top: s2, base: repo.rev(`${s1}~1`) }])).toEqual({
      [s2]: { tip: s2, how: 'squash', trunkCommit: repo.rev('main') },
    });
    // The branch itself still has unmerged work (f1, f2), so it isn't marked.
    expect(await d.detect(raw)).toEqual({});
  });

  it('detects a merge through the remote copy when the local branch is behind it', async () => {
    setup();
    repo.sh('remote', 'add', 'origin', '/nonexistent');
    // The MR branch moves on elsewhere: one more commit and a merge of main, then it's squash-merged.
    repo.checkout('-b', 'remote-work', 'feat');
    repo.commit('f3 from another machine');
    repo.merge('main', "Merge remote-tracking branch 'origin/main' into feat");
    const remoteTip = repo.rev('HEAD');
    repo.sh('update-ref', 'refs/remotes/origin/feat', remoteTip);
    repo.checkout('main');
    repo.sh('merge', '--squash', 'remote-work');
    repo.sh('commit', '-q', '-m', 'squashed feat (remote version)');
    repo.sh('branch', '-D', 'remote-work');
    repo.checkout('feat');
    repo.sh('branch', '--set-upstream-to=origin/feat');
    repo.checkout('main');

    const result = await detect();
    expect(result.feat).toEqual({ tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main'), via: 'origin/feat' });
  });

  it('gives the right answer when two detections run at once (back-to-back reloads)', async () => {
    setup();
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'squashed feat');
    const raw1 = await loadRepo(repo.git, { trunkCommits: 50 });
    const raw2 = await loadRepo(repo.git, { trunkCommits: 50 });
    const d = new MergeDetector(repo.git);
    const [a, b] = await Promise.all([d.detect(raw1), d.detect(raw2)]);
    const expected = { feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main') } };
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    // And the cache isn't poisoned for later runs.
    expect(await d.detect(raw2)).toEqual(expected);
  });

  it('ignores unmerged branches and branches with new work after the squash', async () => {
    setup();
    expect(await detect()).toEqual({});
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'squashed feat');
    repo.checkout('feat');
    repo.commit('f3');
    repo.checkout('main');
    expect(await detect()).toEqual({});
  });
});
