import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffRefs, listFilesBetween, openAll, openDiff } from '../diff/diffs';
import { Git } from '../git/gitCli';
import type { API, Repository } from '../git/gitApi';
import { MergeDetector, type MergedInfo } from '../git/merged';
import { loadRepo } from '../git/repoData';
import { computeLayout, type Alignment } from '../graph/layout';
import type { HostMessage, PushMode, Settings, WebviewMessage } from '../protocol';
import { isDirty, rebaseState, rebaseStep, replayCount, runRebase, undoRebase } from '../rebase/execute';
import { planRebase } from '../rebase/plan';
import { mergePreview, mergeState, mergeStep, runMerge, undoMerge } from '../merge/merge';
import type { RawGraph } from '../types';

const READ_ONLY_GIT = new Set(['log', 'rev-list', 'rev-parse', 'for-each-ref', 'symbolic-ref', 'diff', 'status', 'merge-base']);
const isReadOnly = (args: string[]) => READ_ONLY_GIT.has(args[0]) || (args[0] === 'worktree' && args[1] === 'list');
type RemoteStatus = 'exists' | 'gone' | 'unknown';
const HEADER_HEIGHT_KEY = 'gitLanes.headerHeight';
const DEFAULT_HEADER_HEIGHT = 120;

function settings(): Omit<Settings, 'headerHeight'> & { trunk: string; trunkCommits: number } {
  const c = vscode.workspace.getConfiguration('gitLanes');
  return {
    alignment: c.get<Alignment>('alignment', 'top'),
    showMergedLanes: c.get<boolean>('showMergedLanes', true),
    subjects: c.get<'head' | 'none'>('subjects', 'head'),
    trunk: c.get<string>('trunk', ''),
    trunkCommits: c.get<number>('trunkCommits', 50),
  };
}

export class GraphPanel {
  private static panels = new Map<string, GraphPanel>();

  static show(context: vscode.ExtensionContext, api: API, repo: Repository, log?: vscode.LogOutputChannel): void {
    const key = repo.rootUri.fsPath;
    const existing = GraphPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    GraphPanel.panels.set(key, new GraphPanel(context, api, repo, log));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly git: Git;
  private readonly disposables: vscode.Disposable[] = [];
  private raw?: RawGraph;
  private extraTrunk = 0;
  private stale = true;
  private refreshTimer?: NodeJS.Timeout;
  private loading?: Promise<void>;
  private readonly mergeDetector: MergeDetector;
  private merged: Record<string, MergedInfo> = {};
  private mergedChains: Record<string, MergedInfo> = {};

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: API,
    private readonly repo: Repository,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.git = new Git(repo.rootUri.fsPath, api.git.path, (args, r, ms) => {
      const line = `git ${args.join(' ')} → exit ${r.code} (${ms} ms)`;
      // Reads are routine (and some, like symbolic-ref on a detached HEAD, fail by design).
      if (isReadOnly(args)) log?.debug(r.code === 0 ? line : `${line}: ${r.stderr.trim()}`);
      else if (r.code !== 0) log?.warn(`${line}\n${(r.stderr || r.stdout).trim()}`);
      else log?.info(line);
    });
    this.mergeDetector = new MergeDetector(this.git);
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'gitLanes',
      `Git Lanes: ${path.basename(repo.rootUri.fsPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    const icon = (theme: string) => vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', `lanes-${theme}.svg`);
    this.panel.iconPath = { light: icon('light'), dark: icon('dark') };
    this.panel.webview.html = this.html(dist);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.visible && this.stale) this.refresh();
      }),
      repo.state.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitLanes')) this.refresh();
      }),
    );
  }

  private dispose(): void {
    GraphPanel.panels.delete(this.repo.rootUri.fsPath);
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }

  private refresh(): Promise<void> {
    if (!this.panel.visible) {
      this.stale = true;
      return Promise.resolve();
    }
    // Coalesce: if a load is running, run once more after it.
    this.loading = (this.loading ?? Promise.resolve()).then(() => this.load());
    return this.loading;
  }

  private async load(): Promise<void> {
    this.stale = false;
    const s = settings();
    try {
      const [raw, rebase, merging] = await Promise.all([
        loadRepo(this.git, { trunk: s.trunk || undefined, trunkCommits: s.trunkCommits + this.extraTrunk }),
        rebaseState(this.git),
        mergeState(this.git),
      ]);
      this.raw = raw;
      this.log?.info(`loaded: HEAD=${raw.head.branch ?? raw.head.sha.slice(0, 7)}, ${raw.branches.length} branches, ${Object.keys(raw.commits).length} commits${rebase ? ', rebase in progress' : ''}`);
      this.post({
        type: 'graph',
        raw,
        settings: {
          alignment: s.alignment,
          showMergedLanes: s.showMergedLanes,
          subjects: s.subjects,
          headerHeight: this.context.globalState.get(HEADER_HEIGHT_KEY, DEFAULT_HEADER_HEIGHT),
        },
        rebase: rebase ?? null,
        merging: merging ?? null,
        repoName: path.basename(this.repo.rootUri.fsPath),
      });
      // Squash/rebase-merge detection can take a few seconds the first time; don't hold up the graph.
      void this.detectMerged(raw);
    } catch (e) {
      this.log?.error(`load failed: ${(e as Error).message}`);
      this.post({ type: 'error', message: String((e as Error).message ?? e) });
    }
  }

  private async detectMerged(raw: RawGraph): Promise<void> {
    try {
      this.merged = await this.mergeDetector.detect(raw);
      // Branch marks first; the merged-lanes check below can take longer on a cold start.
      if (this.raw === raw) this.post({ type: 'merged', merged: this.merged, chains: this.mergedChains });
      const chains = computeLayout(raw, { alignment: 'top' })
        .lanes.filter((l) => l.kind === 'merged')
        .map((l) => ({ top: l.commits[0], base: raw.commits[l.commits[l.commits.length - 1]].parents[0] }))
        .filter((c) => c.base);
      this.mergedChains = await this.mergeDetector.detectChains(raw, chains);
      if (this.raw === raw) this.post({ type: 'merged', merged: this.merged, chains: this.mergedChains });
    } catch (e) {
      this.log?.warn(`merge detection failed: ${(e as Error).message}`);
    }
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    // `t` is when the webview sent it: a large gap means the extension host was busy.
    const transit = m.t ? ` (+${Date.now() - m.t} ms to arrive)` : '';
    if (m.type !== 'listFiles' && m.type !== 'probeRemote') this.log?.info(`webview: ${JSON.stringify({ ...m, t: undefined })}${transit}`);
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return await this.refresh();
        case 'loadMore':
          this.extraTrunk += 100;
          return await this.refresh();
        case 'setAlignment':
          return await vscode.workspace
            .getConfiguration('gitLanes')
            .update('alignment', m.alignment, vscode.ConfigurationTarget.Global);
        case 'setShowMergedLanes':
          return await vscode.workspace
            .getConfiguration('gitLanes')
            .update('showMergedLanes', m.show, vscode.ConfigurationTarget.Global);
        case 'setHeaderHeight':
          return await this.context.globalState.update(HEADER_HEIGHT_KEY, m.height);
        case 'listFiles': {
          const [left, right] = await diffRefs(this.git, m.shas);
          const files = await listFilesBetween(this.git, left, right);
          return this.post({ type: 'files', shas: m.shas, files, left, right });
        }
        case 'openDiff':
          return await openDiff(this.api, this.git, m.shas, m.file);
        case 'openAll':
          return await openAll(this.api, this.git, m.shas);
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(`Copied ${m.text}`, 2000);
          return;
        case 'checkout':
          return await this.checkout(m.ref);
        case 'push':
          return await this.push(m.branch, m.remote, m.setUpstream, m.mode);
        case 'probeRemote':
          for (const name of m.branches) {
            const loc = this.remoteOf(name);
            if (loc) void this.probeRemote(loc.remote, loc.remoteBranch);
          }
          return;
        case 'deleteBranch':
          return await this.deleteBranch(m.branch);
        case 'rebase':
          return await this.rebase(m.branch, m.target);
        case 'merge':
          return await this.merge(m.ref);
        case 'mergeStep':
          await this.withBusy(() => mergeStep(this.git, m.step));
          return await this.refresh();
        case 'rebaseStep':
          await this.withBusy(() => rebaseStep(this.git, m.step));
          return await this.refresh();
        case 'openScm':
          await vscode.commands.executeCommand('workbench.view.scm');
          return;
      }
    } catch (e) {
      this.log?.error(`${m.type} failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Git Lanes: ${(e as Error).message}`);
      await this.refresh();
    }
  }

  private async checkout(ref: string): Promise<void> {
    const branch = this.raw?.branches.find((b) => b.name === ref);
    if (branch?.worktree) {
      // git refuses to check out a branch that another worktree has checked out.
      const choice = await vscode.window.showInformationMessage(
        `${ref} is checked out in another worktree: ${branch.worktree}`,
        'Open Worktree',
        'Check Out Detached',
      );
      if (choice === 'Open Worktree') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(branch.worktree), { forceNewWindow: true });
        return;
      }
      if (choice !== 'Check Out Detached') return;
      await this.git.run(['checkout', '--detach', branch.tip, '--']);
      vscode.window.setStatusBarMessage(`Checked out ${branch.tip.slice(0, 7)} (detached, ${ref})`, 3000);
      return await this.refresh();
    }
    // Trailing `--` so a ref is never mistaken for a path.
    await this.git.run(['checkout', ref, '--']);
    vscode.window.setStatusBarMessage(`Checked out ${/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref}`, 3000);
    await this.refresh();
  }

  private async merge(ref: string): Promise<void> {
    const raw = this.raw;
    if (!raw) return;
    const current = raw.head.branch;
    if (!current) {
      void vscode.window.showWarningMessage('HEAD is detached. Check out the branch you want to merge into first.');
      return;
    }
    if (ref === current) return;
    if (await rebaseState(this.git)) throw new Error('A rebase is in progress; finish or abort it first.');
    const { incoming, fastForward } = await mergePreview(this.git, ref);
    if (!incoming) {
      void vscode.window.showInformationMessage(`${current} already contains everything in ${ref}.`);
      return;
    }
    const detail = [
      `Brings ${incoming} commit${incoming === 1 ? '' : 's'} from ${ref} into ${current}.`,
      fastForward
        ? `${current} has nothing ${ref} doesn't, so Merge just moves ${current} up to ${ref} (fast-forward). Choose the other option to record a merge commit anyway.`
        : `This creates a merge commit on ${current}.`,
      (await isDirty(this.git)) ? 'Uncommitted changes will be stashed and re-applied (--autostash).' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const MERGE = 'Merge';
    const NO_FF = 'Merge (always create a merge commit)';
    const choice = await vscode.window.showWarningMessage(
      `Merge ${ref} into ${current}?`,
      { modal: true, detail },
      ...(fastForward ? [MERGE, NO_FF] : [MERGE]),
    );
    if (choice !== MERGE && choice !== NO_FF) return;

    const result = await this.withBusy(() => runMerge(this.git, ref, choice === NO_FF));
    await this.refresh();
    if (result.status === 'error') {
      void vscode.window.showErrorMessage(`Merge failed: ${result.message}`);
      return;
    }
    if (result.status === 'conflict') {
      void vscode.window.showWarningMessage(`Merging ${ref} into ${current} stopped on conflicts. Resolve them, stage the files, then use Continue in the graph.`);
      return;
    }
    if (result.status === 'uptodate') {
      void vscode.window.showInformationMessage(`${current} already contains everything in ${ref}.`);
      return;
    }
    const undo = await vscode.window.showInformationMessage(`Merged ${ref} into ${current}.`, 'Undo');
    if (undo === 'Undo') {
      await undoMerge(this.git, result.oldHead);
      await this.refresh();
    }
  }

  private async push(branch: string, remote: string, setUpstream: boolean, mode: PushMode): Promise<void> {
    const args = ['push'];
    if (setUpstream) args.push('--set-upstream');
    if (mode === 'forceWithLease') args.push('--force-with-lease');
    if (mode === 'force') args.push('--force');
    args.push(remote, branch);
    const title = `Pushing ${branch} to ${remote}${mode === 'normal' ? '' : mode === 'force' ? ' (force)' : ' (force with lease)'}…`;
    // No terminal is attached, so never let git wait on a credential prompt.
    const result = await this.withBusy(() =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
        this.git.exec(args, { GIT_TERMINAL_PROMPT: '0' }),
      ),
    );
    await this.refresh();
    const output = `${result.stderr}\n${result.stdout}`;
    if (result.code !== 0) {
      const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info/.test(output);
      const hint = rejected && mode === 'normal' ? ' The remote has commits you don\'t; use Force with lease to overwrite them.' : '';
      void vscode.window.showErrorMessage(`Push failed: ${output.trim().split('\n').slice(-3).join(' ')}${hint}`);
      return;
    }
    // Remotes like GitLab/GitHub print a link to open a merge/pull request.
    const links = [...output.matchAll(/^remote:\s+(https?:\/\/\S+)/gm)].map((m) => m[1]);
    const choice = await vscode.window.showInformationMessage(`Pushed ${branch} to ${remote}.`, ...(links.length ? ['Open Link'] : []));
    if (choice === 'Open Link') await vscode.env.openExternal(vscode.Uri.parse(links[0]));
  }

  /** Where a branch lives on the remote: its upstream, or failing that <remote>/<name>. */
  private remoteOf(name: string): { remote: string; remoteBranch: string; remoteName: string } | undefined {
    const raw = this.raw;
    if (!raw || !raw.remotes.length) return undefined;
    const b = name === raw.trunk.name && !raw.trunk.remote ? raw.trunk : raw.branches.find((x) => x.name === name);
    const remote = b?.upstreamRemote ?? (raw.remotes.includes('origin') ? 'origin' : raw.remotes[0]);
    const remoteName = b?.upstream ?? `${remote}/${name}`;
    return { remote, remoteBranch: remoteName.slice(remote.length + 1), remoteName };
  }

  private readonly remoteProbes = new Map<string, { at: number; result: Promise<RemoteStatus> }>();

  /**
   * Whether a branch still exists on the server (its remote-tracking ref can be stale, e.g. after
   * GitLab deletes a merged MR's branch). Cached for a minute; never waits on credential prompts.
   */
  private probeRemote(remote: string, remoteBranch: string): Promise<RemoteStatus> {
    const key = `${remote}\0${remoteBranch}`;
    const cached = this.remoteProbes.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.result;
    const lookup = this.git
      .exec(['ls-remote', '--heads', remote, `refs/heads/${remoteBranch}`], { GIT_TERMINAL_PROMPT: '0' })
      .then((r): RemoteStatus => (r.code !== 0 ? 'unknown' : r.stdout.trim() ? 'exists' : 'gone'));
    const timeout = new Promise<RemoteStatus>((resolve) => setTimeout(() => resolve('unknown'), 5000));
    const result = Promise.race([lookup, timeout]);
    this.remoteProbes.set(key, { at: Date.now(), result });
    return result;
  }

  private async deleteBranch(name: string): Promise<void> {
    const raw = this.raw;
    if (!raw) return;
    const started = Date.now();
    const branch = name === raw.trunk.name && !raw.trunk.remote ? raw.trunk : raw.branches.find((b) => b.name === name);
    if (!branch) throw new Error(`No local branch named ${name}.`);
    if (raw.head.branch === name) {
      void vscode.window.showWarningMessage(`${name} is checked out. Check out another branch before deleting it.`);
      return;
    }
    const sha = (await this.git.run(['rev-parse', `refs/heads/${name}`])).trim();
    // The branch's copy on the remote: its upstream, or failing that <remote>/<name> if it exists.
    const loc = this.remoteOf(name);
    const remoteName = loc?.remoteName ?? `origin/${name}`;
    const remoteSha = loc && (await this.git.tryRun(['rev-parse', '--verify', '-q', `refs/remotes/${remoteName}`]))?.trim();
    // Usually already answered: the popover starts this check when it opens.
    const remoteStatus = remoteSha && loc ? await this.probeRemote(loc.remote, loc.remoteBranch) : undefined;
    const count = async (...exclude: string[]) =>
      Number((await this.git.run(['rev-list', '--count', sha, '--not', ...exclude, '--'])).trim());
    const notOnTrunk = name === raw.trunk.name ? 0 : await count(raw.trunk.tip);
    // Commits that exist nowhere else: on neither trunk nor the remote branch.
    const unsaved = notOnTrunk && remoteSha ? await count(raw.trunk.tip, remoteSha) : notOnTrunk;
    const merged = this.merged[name]?.tip === sha ? this.merged[name] : undefined;
    const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
    const detail = [
      merged
        ? `Its changes are on ${raw.trunk.name} (${merged.how === 'squash' ? 'squash' : 'rebase'}-merged as ${merged.trunkCommit.slice(0, 10)}${merged.via ? `, via ${merged.via}, which contains all of its commits` : ''}), so nothing is lost.`
        : !notOnTrunk
        ? `All of its commits are on ${raw.trunk.name}.`
        : !unsaved
        ? `${commits(notOnTrunk)} ${notOnTrunk === 1 ? "isn't" : "aren't"} on ${raw.trunk.name}, but ${notOnTrunk === 1 ? "it's" : "they're all"} on ${remoteName}, so nothing is lost.`
        : `${commits(unsaved)} ${unsaved === 1 ? 'is' : 'are'} on neither ${raw.trunk.name}${remoteSha ? ` nor ${remoteName}` : ''}. After deleting, ${unsaved === 1 ? 'it' : 'they'} can only be recovered from the reflog (tip ${sha.slice(0, 7)}).`,
    ]
      .filter(Boolean)
      .join('\n');
    // Safe to delete the server copy too only if nothing would be lost: merged, or all on trunk.
    const remoteDeletable = remoteStatus === 'exists' && (!!merged || !notOnTrunk);
    const remoteDetail = !remoteSha
      ? ''
      : remoteStatus === 'gone'
      ? `${remoteName} was already deleted on ${loc!.remote} (e.g. when the merge request merged); its leftover local reference will be removed too.`
      : remoteStatus === 'exists'
      ? remoteDeletable
        ? `${remoteName} still exists on ${loc!.remote}. You can delete it too.`
        : `${remoteName} still exists on ${loc!.remote} and is not deleted (it has work that isn't on ${raw.trunk.name}).`
      : `Couldn't reach ${loc!.remote} to check ${remoteName}; only the local branch is deleted.`;

    // git won't delete a branch another worktree has checked out; offer to remove that worktree too.
    const wt = branch.worktree;
    const wtExists = !!wt && existsSync(wt);
    let wtDirty = 0;
    if (wt && wtExists) {
      const status = await new Git(wt, this.api.git.path).tryRun(['status', '--porcelain']);
      wtDirty = status ? status.split('\n').filter(Boolean).length : 0;
    }
    const wtDetail = !wt
      ? ''
      : !wtExists
      ? `Its worktree folder (${wt}) no longer exists; git's record of it will be cleaned up.`
      : [
          `Removing the worktree deletes the folder ${wt}, including files git ignores.`,
          wtDirty
            ? `It has uncommitted or untracked changes in ${wtDirty} file${wtDirty === 1 ? '' : 's'}, which will be lost.`
            : 'It has no uncommitted changes.',
        ].join('\n');
    const LOCAL = wt ? 'Delete Worktree and Branch' : remoteDeletable ? 'Delete Local Only' : 'Delete';
    const BOTH = wt ? 'Delete Worktree, Branch and Remote' : 'Delete Local and Remote';
    const title = wt ? `${name} is checked out in a worktree. Delete the worktree and the branch?` : `Delete branch ${name}?`;
    this.log?.info(`delete dialog for ${name} ready in ${Date.now() - started} ms (remote: ${remoteStatus ?? 'none'})`);
    const choice = await vscode.window.showWarningMessage(
      title,
      { modal: true, detail: [wtDetail, detail, remoteDetail].filter(Boolean).join('\n\n') },
      ...(remoteDeletable ? [LOCAL, BOTH] : [LOCAL]),
    );
    if (choice !== LOCAL && choice !== BOTH) return;
    const deleteRemote = choice === BOTH;

    // Remote first: if the server refuses, nothing has been deleted yet.
    if (deleteRemote) {
      const r = await this.withBusy(() =>
        this.git.exec(['push', loc!.remote, '--delete', loc!.remoteBranch], { GIT_TERMINAL_PROMPT: '0' }),
      );
      if (r.code !== 0) throw new Error(`Couldn't delete ${remoteName}: ${(r.stderr || r.stdout).trim()}`);
    }
    if (wt) {
      if (wtExists) await this.git.run(['worktree', 'remove', ...(wtDirty ? ['--force'] : []), wt]);
      else await this.git.run(['worktree', 'prune']);
    }
    await this.git.run(['branch', '-D', name]);
    const staleRef = remoteStatus === 'gone';
    if (staleRef) await this.git.tryRun(['update-ref', '-d', `refs/remotes/${remoteName}`]);
    this.remoteProbes.clear();
    await this.refresh();
    const what = [wt && wtExists ? `branch ${name} and its worktree` : `branch ${name}`, deleteRemote ? ` and ${remoteName}` : ''].join('');
    const undo = await vscode.window.showInformationMessage(`Deleted ${what} (was ${sha.slice(0, 7)}).`, 'Undo');
    if (undo === 'Undo') {
      await this.git.run(['branch', name, sha]);
      // Re-create the worktree (uncommitted changes from before can't be brought back).
      if (wt && wtExists) await this.git.run(['worktree', 'add', wt, name]);
      if (deleteRemote) {
        await this.git.run(['push', loc!.remote, `${remoteSha}:refs/heads/${loc!.remoteBranch}`], { GIT_TERMINAL_PROMPT: '0' });
      }
      if (staleRef || deleteRemote) await this.git.tryRun(['update-ref', `refs/remotes/${remoteName}`, remoteSha!]);
      if (branch.upstream && !branch.untracked) await this.git.tryRun(['branch', `--set-upstream-to=${branch.upstream}`, name]);
      await this.refresh();
    }
  }

  private async withBusy<T>(fn: () => Thenable<T>): Promise<T> {
    this.post({ type: 'busy', busy: true });
    try {
      return await fn();
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async rebase(branch: string, target: string): Promise<void> {
    if (!this.raw) return;
    // Same hidden chains as the webview, so lanes and edges match what was dragged.
    const layout = computeLayout(this.raw, {
      alignment: 'top',
      hiddenChains: new Set(Object.keys(this.mergedChains)),
      hideMergedLanes: !settings().showMergedLanes,
    });
    const lane = layout.lanes.findIndex((l) => l.kind === 'branch' && l.name === branch);
    if (lane < 0) throw new Error(`No lane for ${branch}.`);
    const plan = planRebase(this.raw, layout, lane, target, { dirty: await isDirty(this.git) });
    const count = await replayCount(this.git, plan);
    const t = this.raw.commits[target];
    const detail = [
      `Replays ${count} commit${count === 1 ? '' : 's'} onto ${target.slice(0, 7)} "${t?.subject ?? ''}".`,
      ...plan.warnings.map((w) => `• ${w}`),
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(`Rebase ${branch}?`, { modal: true, detail }, 'Rebase');
    if (choice !== 'Rebase') return;

    const result = await this.withBusy(() => runRebase(this.git, plan));
    await this.refresh();
    if (result.status === 'error') {
      void vscode.window.showErrorMessage(`Rebase failed: ${result.message}`);
      return;
    }
    if (result.status === 'conflict') {
      void vscode.window.showWarningMessage(
        `Rebase of ${branch} stopped on a conflict. Resolve it, then use Continue in the graph.`,
      );
      return;
    }
    const undo = await vscode.window.showInformationMessage(`Rebased ${branch} onto ${target.slice(0, 7)}.`, 'Undo');
    if (undo === 'Undo') {
      await undoRebase(this.git, result.undo);
      await this.refresh();
    }
  }

  private html(dist: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Git Lanes</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
