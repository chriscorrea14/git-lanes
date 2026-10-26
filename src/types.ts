export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  subject: string;
  body: string;
}

export interface Branch {
  name: string;
  tip: string;
  upstream?: string;
  /** Remote name of the upstream (e.g. "origin"). */
  upstreamRemote?: string;
  /**
   * True when `upstream` is a same-named remote branch found without tracking being configured
   * (pushed without --set-upstream), rather than a real upstream.
   */
  untracked?: boolean;
  /** Undefined when the upstream ref doesn't exist locally. */
  upstreamSha?: string;
  ahead: number;
  behind: number;
  /** Detached HEAD pseudo-branch. */
  detached?: boolean;
  /** Path of another worktree that has this branch checked out (git won't check it out here too). */
  worktree?: string;
}

export interface RawGraph {
  /** `remote` is true when trunk is a remote-tracking ref (e.g. origin/main) rather than a local branch. */
  trunk: Branch & { commits: string[]; hasMore: boolean; remote: boolean };
  /** Local branches other than trunk (plus a detached-HEAD pseudo-branch). */
  branches: Branch[];
  head: { branch?: string; sha: string };
  commits: Record<string, Commit>;
  /**
   * Trunk-reachable commits that are referenced (as fork points or branch tips) but are not
   * on the shown first-parent trunk chain, mapped to the trunk-chain commit that contains them.
   */
  attach: Record<string, string>;
  /** Configured remotes (`git remote`). */
  remotes: string[];
}
