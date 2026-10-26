import { afterEach, describe, expect, it } from 'vitest';
import { loadRepo } from '../src/git/repoData';
import { computeLayout } from '../src/graph/layout';
import { isDirty, rebaseState, rebaseStep, replayCount, runRebase, undoRebase } from '../src/rebase/execute';
import { draggableLane, invalidTargets, planRebase } from '../src/rebase/plan';
import { TestRepo } from './repoHelper';

let repo: TestRepo;
afterEach(() => repo?.dispose());

async function load() {
  const raw = await loadRepo(repo.git, { trunkCommits: 50 });
  return { raw, layout: computeLayout(raw, { alignment: 'top' }) };
}

/** main: m1-m2-m3; feat/x: a-b-c off m1; feat/y: d off b (stacked). HEAD on main. */
function setup() {
  repo = new TestRepo();
  const s: Record<string, string> = {};
  s.m1 = repo.commit('m1');
  s.m2 = repo.commit('m2');
  s.m3 = repo.commit('m3');
  repo.checkout('-b', 'feat/x', s.m1);
  s.a = repo.commit('a');
  s.b = repo.commit('b');
  s.c = repo.commit('c');
  repo.checkout('-b', 'feat/y', s.b);
  s.d = repo.commit('d');
  repo.checkout('main');
  return s;
}

describe('planRebase', () => {
  it('only lets branch lanes be dragged', async () => {
    const s = setup();
    const { layout } = await load();
    expect(draggableLane(layout, s.m2)).toBeUndefined();
    expect(draggableLane(layout, s.b)).toBeDefined();
  });

  it('forbids dropping onto own commits, descendants and current base', async () => {
    const s = setup();
    const { layout } = await load();
    const invalid = invalidTargets(layout, draggableLane(layout, s.b)!);
    for (const sha of [s.a, s.b, s.c, s.d, s.m1]) expect(invalid.has(sha)).toBe(true);
    expect(invalid.has(s.m3)).toBe(false);
  });

  it('uses trunk tip as upstream for trunk-based branches and warns about stacks', async () => {
    const s = setup();
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.b)!, s.m3, { dirty: false });
    expect(plan.branch).toBe('feat/x');
    expect(plan.upstream).toBe(s.m3);
    expect(plan.warnings.join('\n')).toMatch(/check out feat\/x/);
    expect(plan.warnings.join('\n')).toMatch(/stacked.*feat\/y/);
  });

  it('uses parent branch tip as upstream for stacked branches', async () => {
    const s = setup();
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.d)!, s.m3, { dirty: true });
    expect(plan.upstream).toBe(s.c);
    expect(plan.warnings.join('\n')).toMatch(/autostash/);
  });
});

describe('planRebase worktrees', () => {
  it('refuses branches checked out in another worktree', async () => {
    const s = setup();
    const { raw, layout } = await load();
    raw.branches.find((b) => b.name === 'feat/x')!.worktree = '/elsewhere';
    expect(() => planRebase(raw, layout, draggableLane(layout, s.b)!, s.m3, { dirty: false })).toThrow(
      /checked out in another worktree \(\/elsewhere\)/,
    );
  });
});

describe('runRebase', () => {
  it('rebases the whole branch onto the target and can be undone', async () => {
    const s = setup();
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.b)!, s.m3, { dirty: false });
    expect(await replayCount(repo.git, plan)).toBe(3);
    const result = await runRebase(repo.git, plan);
    expect(result.status).toBe('done');
    expect(repo.sh('log', '--format=%s', 'main..feat/x').split('\n')).toEqual(['c', 'b', 'a']);
    expect(repo.rev('feat/x~3')).toBe(s.m3);
    expect(repo.sh('symbolic-ref', '--short', 'HEAD')).toBe('feat/x');

    if (result.status !== 'done') throw new Error();
    await undoRebase(repo.git, result.undo);
    expect(repo.rev('feat/x')).toBe(s.c);
  });

  it('rebases a stacked branch without replaying the parent branch', async () => {
    const s = setup();
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.d)!, s.m3, { dirty: false });
    await runRebase(repo.git, plan);
    expect(repo.sh('log', '--format=%s', 'main..feat/y').split('\n')).toEqual(['d']);
  });

  it('stops on conflict; abort restores, continue finishes', async () => {
    repo = new TestRepo();
    const m1 = repo.commit('m1', 'f.txt', 'base');
    const m2 = repo.commit('m2', 'f.txt', 'main change');
    repo.checkout('-b', 'feat', m1);
    const f1 = repo.commit('f1', 'f.txt', 'feat change');
    repo.checkout('main');

    let { raw, layout } = await load();
    let plan = planRebase(raw, layout, draggableLane(layout, f1)!, m2, { dirty: false });
    let result = await runRebase(repo.git, plan);
    expect(result.status).toBe('conflict');
    expect(await rebaseState(repo.git)).toMatchObject({ branch: 'feat', step: 1, total: 1 });
    await expect(rebaseStep(repo.git, 'continue')).rejects.toThrow();
    await rebaseStep(repo.git, 'abort');
    expect(await rebaseState(repo.git)).toBeUndefined();
    expect(repo.rev('feat')).toBe(f1);

    ({ raw, layout } = await load());
    plan = planRebase(raw, layout, draggableLane(layout, f1)!, m2, { dirty: false });
    result = await runRebase(repo.git, plan);
    expect(result.status).toBe('conflict');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${repo.dir}/f.txt`, 'resolved\n');
    repo.sh('add', 'f.txt');
    await rebaseStep(repo.git, 'continue');
    expect(await rebaseState(repo.git)).toBeUndefined();
    expect(repo.rev('feat~1')).toBe(m2);
  });

  it('autostashes a dirty tree', async () => {
    const s = setup();
    repo.checkout('feat/x');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${repo.dir}/a.txt`, 'dirty\n');
    expect(await isDirty(repo.git)).toBe(true);
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.b)!, s.m3, { dirty: true });
    expect((await runRebase(repo.git, plan)).status).toBe('done');
    expect(await isDirty(repo.git)).toBe(true);
  });

  it('reports git errors', async () => {
    const s = setup();
    const { raw, layout } = await load();
    const plan = planRebase(raw, layout, draggableLane(layout, s.b)!, s.m3, { dirty: false });
    const result = await runRebase(repo.git, { ...plan, target: 'deadbeef' });
    expect(result.status).toBe('error');
  });
});
