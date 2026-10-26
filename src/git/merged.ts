import type { RawGraph } from '../types';
import type { Git } from './gitCli';

/** A branch whose changes are on trunk even though its commits aren't in trunk's history. */
export interface MergedInfo {
  /** Branch tip this was computed for (stale once the branch moves). */
  tip: string;
  how: 'squash' | 'rebase';
  /** The trunk commit carrying the change (for rebase merges, the newest one). */
  trunkCommit: string;
  /**
   * Set when the branch matched only through its remote copy: the local branch is behind that
   * copy (all its commits are in it), and the copy is what got squash/rebase-merged.
   */
  via?: string;
}

/** A run of commits merged into a branch from elsewhere: `base` is where it forked, `top` its newest commit. */
export interface SideChain {
  top: string;
  base: string;
}

/** Trunk commits indexed per scan, newest first. */
const TRUNK_SCAN_LIMIT = 1000;

/** Parses `git patch-id` output ("<patch-id> <commit>" per line) into commit -> patch-id. */
export function parsePatchIds(out: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [pid, commit] = line.trim().split(/\s+/);
    if (pid && commit) ids.set(commit, pid);
  }
  return ids;
}

/** Parses `git log --name-only --format='commit %H'` into commit -> sorted file list key. */
export function parseNameOnly(out: string): Map<string, string> {
  const files = new Map<string, string>();
  let commit: string | undefined;
  let names: string[] = [];
  const flush = () => {
    if (commit && names.length) files.set(commit, names.sort().join('\n'));
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) {
      flush();
      commit = line.slice(7).trim();
      names = [];
    } else if (line) names.push(line);
  }
  flush();
  return files;
}

/**
 * Detects squash- and rebase-merged branches by patch equivalence with trunk:
 * - squash: the branch's whole change (merge-base..tip as one diff) matches one trunk commit,
 *   including a merge commit's change relative to its first parent (GitLab "squash + merge commit");
 * - rebase: every branch commit has a patch-equivalent trunk commit.
 *
 * To stay fast on big repos, trunk is indexed by which files each commit touched (cheap), and
 * patch-ids are only computed for trunk commits touching exactly the same files as the change in
 * question. Patch-ids are cached forever (commits are immutable); the file index is extended
 * incrementally as trunk moves.
 */
export class MergeDetector {
  /** files key -> trunk commits (first-parent, newest first) that touched exactly those files */
  private byFiles = new Map<string, string[]>();
  /** Trunk range indexed so far: first-parent commits after `base` up to `tip`. */
  private covered?: { base: string; tip: string };
  private trunkTip?: string;
  /** commit (or "base..tip") -> patch-id; immutable, never cleared */
  private patchIdCache = new Map<string, string | null>();
  private results = new Map<string, MergedInfo | null>();

  constructor(private readonly git: Git) {}

  /** Runs one detection at a time: concurrent runs share the caches and would see them half-built. */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  detect(raw: RawGraph): Promise<Record<string, MergedInfo>> {
    return this.serial(() => this.detectNow(raw));
  }

  detectChains(raw: RawGraph, chains: SideChain[]): Promise<Record<string, MergedInfo>> {
    return this.serial(() => this.detectChainsNow(raw, chains));
  }

  private setTrunk(raw: RawGraph): void {
    if (raw.trunk.tip === this.trunkTip) return;
    this.trunkTip = raw.trunk.tip;
    this.results.clear(); // new trunk commits may now match
  }

  private async detectNow(raw: RawGraph): Promise<Record<string, MergedInfo>> {
    this.setTrunk(raw);
    const candidates = raw.branches.filter((b) => !b.detached && raw.commits[b.tip] && !raw.trunk.commits.includes(b.tip));
    const keyOf = (b: (typeof candidates)[number]) => `${b.name}\0${b.tip}\0${b.upstreamSha ?? ''}`;
    const unchecked = candidates.filter((b) => !this.results.has(keyOf(b)));

    const bases = new Map<string, string>();
    for (const b of unchecked) {
      const mb = await this.mergeBase(raw.trunk.tip, b.tip);
      if (mb) bases.set(b.name, mb);
    }
    if (bases.size) await this.index([...bases.values()]);

    const merged: Record<string, MergedInfo> = {};
    for (const b of candidates) {
      const key = keyOf(b);
      if (!this.results.has(key)) {
        const mb = bases.get(b.name);
        let info = mb ? await this.check(b.tip, mb) : null;
        // Behind its remote copy (e.g. the MR branch got more commits or a merge of main elsewhere)?
        // Then the copy is what was merged; the local commits are all part of it.
        if (!info && b.upstream && b.upstreamSha && b.upstreamSha !== b.tip && (await this.isAncestor(b.tip, b.upstreamSha))) {
          const umb = await this.mergeBase(raw.trunk.tip, b.upstreamSha);
          if (umb) {
            await this.index([umb]);
            const viaInfo = await this.check(b.upstreamSha, umb);
            if (viaInfo) info = { ...viaInfo, tip: b.tip, via: b.upstream };
          }
        }
        this.results.set(key, info);
      }
      const info = this.results.get(key);
      if (info) merged[b.name] = info;
    }
    return merged;
  }

  /** Like detect, for merged-in side chains (keyed by chain top). */
  private async detectChainsNow(raw: RawGraph, chains: SideChain[]): Promise<Record<string, MergedInfo>> {
    this.setTrunk(raw);
    const key = (c: SideChain) => `chain\0${c.base}\0${c.top}`;
    const unchecked = chains.filter((c) => !this.results.has(key(c)));
    const bases: string[] = [];
    for (const c of unchecked) {
      const mb = await this.mergeBase(raw.trunk.tip, c.top);
      if (mb) bases.push(mb);
    }
    if (bases.length) await this.index(bases);
    const merged: Record<string, MergedInfo> = {};
    for (const c of chains) {
      if (!this.results.has(key(c))) this.results.set(key(c), await this.check(c.top, c.base));
      const info = this.results.get(key(c));
      if (info) merged[c.top] = info;
    }
    return merged;
  }

  private async mergeBase(a: string, b: string): Promise<string | undefined> {
    return (await this.git.tryRun(['merge-base', a, b]))?.trim() || undefined;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git.exec(['merge-base', '--is-ancestor', a, b])).code === 0;
  }

  /** Adds trunk first-parent commits in `range` to the files index. */
  private async scan(range: string): Promise<void> {
    const out = await this.git.run([
      'log', '--first-parent', '--diff-merges=first-parent', '--name-only', '--format=commit %H',
      '-n', String(TRUNK_SCAN_LIMIT), range, '--',
    ]);
    for (const [commit, files] of parseNameOnly(out)) {
      const list = this.byFiles.get(files);
      if (!list) this.byFiles.set(files, [commit]);
      else if (!list.includes(commit)) list.push(commit);
    }
  }

  /** Makes sure the files index covers trunk from the oldest of `bases` up to the current trunk tip. */
  private async index(bases: string[]): Promise<void> {
    const tip = this.trunkTip!;
    let oldest = bases[0];
    for (const b of bases.slice(1)) if (await this.isAncestor(b, oldest)) oldest = b;

    if (!this.covered || !(await this.isAncestor(this.covered.tip, tip))) {
      // First run, or trunk was rewritten: start over.
      this.byFiles.clear();
      await this.scan(`${oldest}..${tip}`);
      this.covered = { base: oldest, tip };
      return;
    }
    if (this.covered.tip !== tip) {
      await this.scan(`${this.covered.tip}..${tip}`); // only what trunk gained since
      this.covered.tip = tip;
    }
    if (!(await this.isAncestor(this.covered.base, oldest))) {
      await this.scan(`${oldest}..${this.covered.base}`); // reach further back
      this.covered.base = oldest;
    }
  }

  private async patchId(diffArgs: string[], cacheKey: string): Promise<string | null> {
    if (this.patchIdCache.has(cacheKey)) return this.patchIdCache.get(cacheKey)!;
    const patch = await this.git.run(diffArgs);
    let pid: string | null = null;
    if (patch.trim()) {
      const r = await this.git.exec(['patch-id', '--stable'], undefined, patch);
      pid = r.code === 0 ? [...parsePatchIds(r.stdout).values()][0] ?? null : null;
    }
    this.patchIdCache.set(cacheKey, pid);
    return pid;
  }

  /** Patch-id of a single commit's change (merges: against the first parent). */
  private commitPatchId(commit: string): Promise<string | null> {
    return this.patchId(['diff', `${commit}^1`, commit, '--'], commit);
  }

  /** The trunk commit among `candidates` whose change has patch-id `pid`, if any. */
  private async findTrunk(pid: string, candidates: string[] | undefined): Promise<string | undefined> {
    for (const c of candidates ?? []) if ((await this.commitPatchId(c)) === pid) return c;
    return undefined;
  }

  private async check(tip: string, base: string): Promise<MergedInfo | null> {
    // Squash: the whole change, compared only with trunk commits touching the same files.
    const wholeFiles = (await this.git.run(['diff', '--name-only', base, tip, '--'])).split('\n').filter(Boolean).sort().join('\n');
    const squashCandidates = this.byFiles.get(wholeFiles);
    if (squashCandidates) {
      const pid = await this.patchId(['diff', base, tip, '--'], `${base}..${tip}`);
      const hit = pid && (await this.findTrunk(pid, squashCandidates));
      if (hit) return { tip, how: 'squash', trunkCommit: hit };
    }

    // Rebase: every commit has an equivalent on trunk. Bail at the first commit with no candidate.
    const perCommit = parseNameOnly(
      await this.git.run(['log', '--no-merges', '--name-only', '--format=commit %H', `${base}..${tip}`, '--']),
    );
    if (!perCommit.size) return null;
    let newest: string | undefined;
    for (const [commit, files] of perCommit) {
      const candidates = this.byFiles.get(files);
      if (!candidates) return null;
      const pid = await this.commitPatchId(commit);
      const hit = pid && (await this.findTrunk(pid, candidates));
      if (!hit) return null;
      newest ??= hit;
    }
    return newest ? { tip, how: 'rebase', trunkCommit: newest } : null;
  }
}
