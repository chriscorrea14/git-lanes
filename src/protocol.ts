import type { Alignment } from './graph/layout';
import type { RebaseState, RebaseStep } from './rebase/execute';
import type { MergedInfo } from './git/merged';
import type { MergeState, MergeStep } from './merge/merge';
import type { RawGraph } from './types';

export interface Settings {
  alignment: Alignment;
  /** Draw lanes for merged-in side chains (otherwise merges show as diamonds only). */
  showMergedLanes: boolean;
  subjects: 'head' | 'none';
  /** Height of the lane-name header in px (user-resizable). */
  headerHeight: number;
}

export type PushMode = 'normal' | 'forceWithLease' | 'force';

export interface FileChange {
  /** A, M, D, R, C, T… */
  status: string;
  path: string;
  oldPath?: string;
  stats?: LineStats;
}

export interface LineStats {
  /** Lines added with no deleted counterpart. */
  added: number;
  /** Lines deleted with no added counterpart. */
  deleted: number;
  /** Lines replaced in place (paired deletion + addition within one change block). */
  modified: number;
  binary: boolean;
}

export type HostMessage =
  | { type: 'graph'; raw: RawGraph; settings: Settings; rebase: RebaseState | null; merging: MergeState | null; repoName: string }
  /** `left`/`right` are the refs actually diffed (older first). */
  | { type: 'files'; shas: string[]; files: FileChange[]; left: string; right: string }
  /** `chains`: merged-in side chains already on trunk, by chain top (hidden from the graph). */
  | { type: 'merged'; merged: Record<string, MergedInfo>; chains: Record<string, MergedInfo> }
  | { type: 'error'; message: string }
  | { type: 'busy'; busy: boolean };

export type WebviewMessage = WebviewMessageBody & {
  /** Send time (ms since epoch), for spotting a busy extension host in the log. */
  t?: number;
};

type WebviewMessageBody =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'setAlignment'; alignment: Alignment }
  | { type: 'setShowMergedLanes'; show: boolean }
  | { type: 'setHeaderHeight'; height: number }
  | { type: 'listFiles'; shas: string[] }
  | { type: 'openDiff'; shas: string[]; file: FileChange }
  | { type: 'openAll'; shas: string[] }
  | { type: 'copy'; text: string }
  | { type: 'checkout'; ref: string }
  | { type: 'deleteBranch'; branch: string }
  /** Start checking whether these branches still exist on the server (ahead of a delete). */
  | { type: 'probeRemote'; branches: string[] }
  | { type: 'push'; branch: string; remote: string; setUpstream: boolean; mode: PushMode }
  | { type: 'rebase'; branch: string; target: string }
  | { type: 'rebaseStep'; step: RebaseStep }
  /** Merge `ref` (a branch name, or trunk) into the checked-out branch. */
  | { type: 'merge'; ref: string }
  | { type: 'mergeStep'; step: MergeStep }
  | { type: 'openScm' };
