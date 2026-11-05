import { afterEach, describe, expect, it } from 'vitest';
import { loadRepo } from '../src/git/repoData';
import { changedLinesId, MergeDetector, parseNameOnly } from '../src/git/merged';
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

/** A file with lines far enough apart that edits to them merge cleanly but appear in each other's context. */
const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive\n';

/** main and a `feat` branch that edits line 3, then main edits line 1 (now context of feat's hunk). */
function setupNeighbouringEdit() {
  repo = new TestRepo();
  repo.commit('base', 'c.txt', FIVE_LINES);
  repo.checkout('-b', 'feat');
  repo.commit('edit line 3', 'c.txt', 'one\ntwo\nTHREE\nfour\nfive\n');
  repo.checkout('main');
  repo.commit('edit line 1', 'c.txt', 'ONE\ntwo\nthree\nfour\nfive\n');
}

describe('changedLinesId', () => {
  const diff = (hunks: string, index = 'index 111..222 100644') =>
    `diff --git a/f.txt b/f.txt\n${index}\n--- a/f.txt\n+++ b/f.txt\n${hunks}`;

  it('ignores context lines, line numbers and blob hashes', () => {
    const a = diff('@@ -1,3 +1,3 @@ first\n one\n-two\n+TWO\n three\n');
    const b = diff('@@ -40,3 +40,3 @@ other\n ONE\n-two\n+TWO\n THREE\n', 'index 333..444 100644');
    expect(changedLinesId(a)).toBe(changedLinesId(b));
  });

  it('tells apart different changes, including lines that look like diff headers', () => {
    const base = changedLinesId(diff('@@ -1 +1 @@\n-two\n+TWO\n'));
    expect(changedLinesId(diff('@@ -1 +1 @@\n-two\n+Two\n'))).not.toBe(base);
    expect(changedLinesId(diff('@@ -1,2 +1 @@\n-two\n--- x\n+TWO\n'))).not.toBe(base);
    expect(changedLinesId(diff('@@ -1 +1,2 @@\n-two\n+TWO\n+++ y\n'))).not.toBe(base);
  });

  it('tells apart the same lines in different files', () => {
    const other = diff('@@ -1 +1 @@\n-two\n+TWO\n').replaceAll('f.txt', 'g.txt');
    expect(changedLinesId(other)).not.toBe(changedLinesId(diff('@@ -1 +1 @@\n-two\n+TWO\n')));
  });

  it('tells apart binary changes by their resulting content', () => {
    const binary = (index: string) => diff('', index).replace('--- a/f.txt\n+++ b/f.txt\n', 'Binary files a/f.txt and b/f.txt differ\n');
    expect(changedLinesId(binary('index 111..222 100644'))).toBe(changedLinesId(binary('index 999..222 100644')));
    expect(changedLinesId(binary('index 111..222 100644'))).not.toBe(changedLinesId(binary('index 111..333 100644')));
  });

  it('has no id for an empty diff', () => {
    expect(changedLinesId('')).toBeNull();
    expect(changedLinesId('\n')).toBeNull();
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

  it('detects a squash merge when trunk changed a context line of the branch', async () => {
    setupNeighbouringEdit();
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'squashed feat');
    expect(await detect()).toEqual({ feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main') } });
  });

  it('detects a rebase merge when trunk changed a context line of a commit', async () => {
    setupNeighbouringEdit();
    repo.checkout('feat');
    repo.commit('edit line 5', 'c.txt', 'one\ntwo\nTHREE\nfour\nFIVE\n');
    repo.checkout('main');
    repo.sh('cherry-pick', repo.rev('feat~1'), repo.rev('feat'));
    expect((await detect()).feat).toMatchObject({ how: 'rebase', trunkCommit: repo.rev('main') });
  });

  it('does not mark a branch whose changed lines differ from a trunk commit on the same file', async () => {
    setupNeighbouringEdit();
    repo.commit('a different edit of line 3', 'c.txt', 'ONE\ntwo\nThree\nfour\nfive\n');
    expect(await detect()).toEqual({});
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
