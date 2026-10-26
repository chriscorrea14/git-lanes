import type { Git } from '../git/gitCli';

export interface MergeState {
  /** First line of MERGE_MSG, e.g. "Merge branch 'feat' into main". */
  message?: string;
}

export type MergeResult =
  | { status: 'done' | 'uptodate'; oldHead: string }
  | { status: 'conflict'; oldHead: string; message: string }
  | { status: 'error'; message: string };

export type MergeStep = 'continue' | 'abort';

const NO_EDITOR = { GIT_EDITOR: 'true' };

/** The in-progress (conflicted) merge, if any. */
export async function mergeState(git: Git): Promise<MergeState | undefined> {
  if (!(await git.tryRun(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) return undefined;
  const msgPath = (await git.tryRun(['rev-parse', '--git-path', 'MERGE_MSG']))?.trim();
  const { readFileSync, existsSync } = await import('node:fs');
  const { isAbsolute, join } = await import('node:path');
  const file = msgPath && (isAbsolute(msgPath) ? msgPath : join(git.cwd, msgPath));
  const message = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : undefined;
  return { message };
}

/** Number of commits `ref` would bring into HEAD, and whether HEAD can simply fast-forward to it. */
export async function mergePreview(git: Git, ref: string): Promise<{ incoming: number; fastForward: boolean }> {
  const incoming = Number((await git.run(['rev-list', '--count', `HEAD..${ref}`, '--'])).trim());
  const fastForward = (await git.exec(['merge-base', '--is-ancestor', 'HEAD', ref])).code === 0;
  return { incoming, fastForward };
}

/** Merges `ref` into the current branch. Uncommitted changes are stashed and re-applied. */
export async function runMerge(git: Git, ref: string, noFastForward: boolean): Promise<MergeResult> {
  if (await mergeState(git)) return { status: 'error', message: 'A merge is already in progress.' };
  const oldHead = (await git.run(['rev-parse', 'HEAD'])).trim();
  const r = await git.exec(['merge', '--autostash', '--no-edit', ...(noFastForward ? ['--no-ff'] : []), ref], NO_EDITOR);
  const output = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) return { status: /Already up to date/i.test(output) ? 'uptodate' : 'done', oldHead };
  if (await mergeState(git)) return { status: 'conflict', oldHead, message: output.trim() };
  return { status: 'error', message: (r.stderr || r.stdout).trim() };
}

/** Finishes (after conflicts are resolved and staged) or aborts the in-progress merge. */
export async function mergeStep(git: Git, step: MergeStep): Promise<void> {
  const r = step === 'continue' ? await git.exec(['commit', '--no-edit'], NO_EDITOR) : await git.exec(['merge', '--abort']);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `merge --${step} failed`);
}

/** Puts the current branch back where it was before a merge, keeping uncommitted changes. */
export async function undoMerge(git: Git, oldHead: string): Promise<void> {
  await git.run(['reset', '--keep', oldHead]);
}
