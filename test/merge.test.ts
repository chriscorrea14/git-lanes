import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mergePreview, mergeState, mergeStep, runMerge, undoMerge } from '../src/merge/merge';
import { TestRepo } from './repoHelper';

let repo: TestRepo;
afterEach(() => repo?.dispose());

describe('merge into current branch', () => {
  it('fast-forwards by default, and can force a merge commit; undo restores', async () => {
    repo = new TestRepo();
    const m1 = repo.commit('m1');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.checkout('main');

    expect(await mergePreview(repo.git, 'feat')).toEqual({ incoming: 1, fastForward: true });
    const ff = await runMerge(repo.git, 'feat', false);
    expect(ff).toEqual({ status: 'done', oldHead: m1 });
    expect(repo.rev('main')).toBe(f1);
    await undoMerge(repo.git, m1);
    expect(repo.rev('main')).toBe(m1);

    await runMerge(repo.git, 'feat', true);
    expect(repo.sh('log', '-1', '--format=%P', 'main').split(' ')).toEqual([m1, f1]);
    expect((await runMerge(repo.git, 'feat', false)).status).toBe('uptodate');
  });

  it('stops on conflict; continue after resolving, or abort', async () => {
    repo = new TestRepo();
    repo.commit('base', 'f.txt', 'base');
    repo.checkout('-b', 'feat');
    repo.commit('feat', 'f.txt', 'feat side');
    repo.checkout('main');
    const m = repo.commit('main', 'f.txt', 'main side');

    expect((await runMerge(repo.git, 'feat', false)).status).toBe('conflict');
    expect(await mergeState(repo.git)).toEqual({ message: "Merge branch 'feat'" });
    await expect(mergeStep(repo.git, 'continue')).rejects.toThrow(); // unresolved
    await mergeStep(repo.git, 'abort');
    expect(await mergeState(repo.git)).toBeUndefined();
    expect(repo.rev('HEAD')).toBe(m);

    await runMerge(repo.git, 'feat', false);
    writeFileSync(`${repo.dir}/f.txt`, 'resolved\n');
    repo.sh('add', 'f.txt');
    await mergeStep(repo.git, 'continue');
    expect(await mergeState(repo.git)).toBeUndefined();
    expect(repo.sh('log', '-1', '--format=%s')).toBe("Merge branch 'feat'");
  });

  it('carries uncommitted changes through the merge', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('-b', 'feat');
    repo.commit('f1');
    repo.checkout('main');
    writeFileSync(`${repo.dir}/m1.txt`, 'local edit\n');
    expect((await runMerge(repo.git, 'feat', true)).status).toBe('done');
    expect(repo.sh('status', '--porcelain')).toBe('M m1.txt');
  });
});
