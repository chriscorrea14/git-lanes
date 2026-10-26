import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Git } from '../git/gitCli';
import type { RebasePlan } from './plan';

export interface RebaseState {
  branch?: string;
  step?: number;
  total?: number;
}

export interface Undo {
  branch: string;
  oldSha: string;
}

export type RebaseResult =
  | { status: 'done'; undo: Undo }
  | { status: 'conflict'; undo: Undo; message: string }
  | { status: 'error'; message: string };

const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

async function gitPath(git: Git, name: string): Promise<string> {
  const p = (await git.run(['rev-parse', '--git-path', name])).trim();
  return isAbsolute(p) ? p : join(git.cwd, p);
}

const readInt = (file: string) => (existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : undefined);

/** The in-progress rebase, if any. */
export async function rebaseState(git: Git): Promise<RebaseState | undefined> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const path = await gitPath(git, dir);
    if (!existsSync(path)) continue;
    const headName = join(path, 'head-name');
    const branch = existsSync(headName) ? readFileSync(headName, 'utf8').trim().replace(/^refs\/heads\//, '') : undefined;
    return dir === 'rebase-merge'
      ? { branch, step: readInt(join(path, 'msgnum')), total: readInt(join(path, 'end')) }
      : { branch, step: readInt(join(path, 'next')), total: readInt(join(path, 'last')) };
  }
  return undefined;
}

export async function isDirty(git: Git): Promise<boolean> {
  return (await git.run(['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
}

/** Number of non-merge commits git will replay. */
export async function replayCount(git: Git, plan: RebasePlan): Promise<number> {
  return Number((await git.run(['rev-list', '--count', '--no-merges', `${plan.upstream}..${plan.branch}`])).trim());
}

export async function runRebase(git: Git, plan: RebasePlan): Promise<RebaseResult> {
  if (await rebaseState(git)) return { status: 'error', message: 'A rebase is already in progress.' };
  const oldSha = (await git.run(['rev-parse', `refs/heads/${plan.branch}`])).trim();
  const undo = { branch: plan.branch, oldSha };
  const result = await git.exec(['rebase', '--autostash', '--onto', plan.target, plan.upstream, plan.branch], NO_EDITOR);
  if (result.code === 0) return { status: 'done', undo };
  const message = (result.stderr || result.stdout).trim();
  if (await rebaseState(git)) return { status: 'conflict', undo, message };
  return { status: 'error', message };
}

export type RebaseStep = 'continue' | 'skip' | 'abort';

/** Runs a step on the in-progress rebase; throws with git's output if it stops again or fails. */
export async function rebaseStep(git: Git, step: RebaseStep): Promise<void> {
  const result = await git.exec(['rebase', `--${step}`], NO_EDITOR);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `git rebase --${step} failed`);
}

export async function undoRebase(git: Git, undo: Undo): Promise<void> {
  const current = (await git.tryRun(['symbolic-ref', '-q', '--short', 'HEAD']))?.trim();
  if (current === undo.branch) await git.run(['reset', '--keep', undo.oldSha]);
  else await git.run(['branch', '-f', undo.branch, undo.oldSha]);
}
