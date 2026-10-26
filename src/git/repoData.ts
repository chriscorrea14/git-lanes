import { realpathSync } from 'node:fs';
import type { Branch, Commit, RawGraph } from '../types';
import type { Git } from './gitCli';

const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e';

export interface LoadOptions {
  /** Trunk branch name; empty to auto-detect. */
  trunk?: string;
  /** Minimum number of first-parent trunk commits to load. */
  trunkCommits: number;
}

export function parseCommits(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, parents, author, email, date, subject, body] = r.split('\x00');
      return {
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date),
        subject,
        body: (body ?? '').trim(),
      };
    });
}

/** Branch name -> worktree path, from `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch) result.set(branch, path);
  }
  return result;
}

/** Parses `%(upstream:track)` output such as "[ahead 2, behind 1]" or "[gone]". */
export function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

async function detectTrunk(git: Git, localNames: Set<string>, configured?: string): Promise<string> {
  if (configured) return configured;
  // Prefer the remote trunk: local main is often stale, and a stale trunk would make
  // upstream commits show up inside feature lanes.
  const originHead = (await git.tryRun(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (originHead) return originHead;
  for (const name of ['main', 'master']) if (localNames.has(name)) return name;
  const current = (await git.tryRun(['symbolic-ref', '-q', '--short', 'HEAD']))?.trim();
  if (current) return current;
  throw new Error('Could not determine a trunk branch; set gitLanes.trunk.');
}

export async function loadRepo(git: Git, opts: LoadOptions): Promise<RawGraph> {
  const [headsOut, remotesOut, headRef, headSha, worktreesOut, toplevel, remoteNames] = await Promise.all([
    git.run([
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(upstream:remotename)',
      'refs/heads',
    ]),
    git.run(['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/remotes']),
    git.tryRun(['symbolic-ref', '-q', '--short', 'HEAD']),
    git.run(['rev-parse', 'HEAD']),
    git.tryRun(['worktree', 'list', '--porcelain']),
    git.run(['rev-parse', '--show-toplevel']),
    git.run(['remote']),
  ]);
  // Branches checked out in a worktree other than this one.
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // e.g. a pruned worktree whose folder is gone
    }
  };
  const here = real(toplevel.trim());
  const elsewhere = new Map([...parseWorktrees(worktreesOut ?? '')].filter(([, path]) => real(path) !== here));

  const remoteShas = new Map<string, string>();
  for (const line of remotesOut.split('\n').filter(Boolean)) {
    const [name, sha] = line.split('\x00');
    remoteShas.set(name, sha);
  }

  const locals: Branch[] = headsOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, tip, upstream, track, upstreamRemote] = line.split('\x00');
      return {
        name,
        tip,
        upstream: upstream || undefined,
        upstreamRemote: upstreamRemote || undefined,
        upstreamSha: upstream ? remoteShas.get(upstream) : undefined,
        worktree: elsewhere.get(name),
        ...parseTrack(track ?? ''),
      };
    });

  // Branches pushed without --set-upstream still have a remote copy: use the same-named branch on
  // origin (or the only remote) so pushed/unpushed state can be shown for them too.
  const remotes = remoteNames.split('\n').filter(Boolean);
  const defaultRemote = remotes.includes('origin') ? 'origin' : remotes[0];
  await Promise.all(
    locals
      .filter((b) => !b.upstream && defaultRemote && remoteShas.has(`${defaultRemote}/${b.name}`))
      .map(async (b) => {
        const ref = `${defaultRemote}/${b.name}`;
        const counts = (await git.run(['rev-list', '--left-right', '--count', `${b.tip}...${remoteShas.get(ref)}`])).trim();
        const [ahead, behind] = counts.split(/\s+/).map(Number);
        Object.assign(b, { upstream: ref, upstreamRemote: defaultRemote, upstreamSha: remoteShas.get(ref), untracked: true, ahead, behind });
      }),
  );

  const head = { branch: headRef?.trim() || undefined, sha: headSha.trim() };
  const trunkName = await detectTrunk(git, new Set(locals.map((b) => b.name)), opts.trunk);
  const trunkLocal = locals.find((b) => b.name === trunkName);
  const trunkTip = trunkLocal?.tip ?? (await git.run(['rev-parse', trunkName])).trim();
  const trunkBranch: Branch = trunkLocal ?? { name: trunkName, tip: trunkTip, ahead: 0, behind: 0 };

  const branches = locals.filter((b) => b.name !== trunkName);
  if (!head.branch) {
    branches.push({ name: 'HEAD', tip: head.sha, ahead: 0, behind: 0, detached: true });
  }

  const commits: Record<string, Commit> = {};

  // Every commit on a local branch that isn't reachable from trunk.
  if (branches.length > 0) {
    const out = await git.run([
      'log',
      '--topo-order',
      `--format=${COMMIT_FORMAT}`,
      ...branches.map((b) => b.tip),
      '--not',
      trunkTip,
      '--',
    ]);
    for (const c of parseCommits(out)) commits[c.sha] = c;
  }

  // Trunk-reachable commits we need to anchor: fork points and tips of fully merged branches.
  const anchors = new Set<string>();
  for (const c of Object.values(commits)) for (const p of c.parents) if (!commits[p]) anchors.add(p);
  for (const b of branches) if (!commits[b.tip]) anchors.add(b.tip);
  anchors.delete(trunkTip);

  // For each anchor, the first-parent trunk commits that descend from it (newest first).
  const descendants = new Map<string, string[]>();
  await Promise.all(
    [...anchors].map(async (a) => {
      const out = await git.run(['rev-list', '--first-parent', '--ancestry-path', `${a}..${trunkTip}`]);
      descendants.set(a, out.split('\n').filter(Boolean));
    }),
  );

  // Load enough trunk to include every anchor (or the commit that merged it), plus a little context.
  let needed = opts.trunkCommits;
  for (const d of descendants.values()) needed = Math.max(needed, d.length + 3);
  const trunkOut = await git.run(['log', '--first-parent', `--format=${COMMIT_FORMAT}`, '-n', String(needed + 1), trunkTip, '--']);
  const trunkCommits = parseCommits(trunkOut);
  const hasMore = trunkCommits.length > needed;
  if (hasMore) trunkCommits.pop();
  for (const c of trunkCommits) commits[c.sha] = c;
  const trunkShas = trunkCommits.map((c) => c.sha);

  const attach: Record<string, string> = {};
  for (const [a, d] of descendants) {
    if (trunkShas[d.length] === a) continue; // on the first-parent chain itself
    const merger = d[d.length - 1];
    if (merger) attach[a] = merger;
  }

  return {
    trunk: { ...trunkBranch, commits: trunkShas, hasMore, remote: !trunkLocal },
    branches,
    head,
    commits,
    attach,
    remotes,
  };
}
