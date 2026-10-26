// Drives GraphPanel end-to-end against a real repo with a mocked vscode module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage, WebviewMessage } from '../src/protocol';
import { TestRepo } from './repoHelper';

const h = vi.hoisted(() => ({
  posted: [] as unknown[],
  onMessage: undefined as undefined | ((m: unknown) => Promise<void>),
  commands: [] as unknown[][],
  warningAnswer: 'Rebase' as string | undefined,
  infoAnswer: undefined as string | undefined,
  infos: [] as unknown[][],
  warnings: [] as unknown[][],
}));

vi.mock('vscode', () => {
  const event = () => () => ({ dispose() {} });
  const uri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` });
  return {
    Uri: { file: uri, from: (c: { scheme: string; path: string }) => ({ empty: `${c.scheme}:${c.path}` }), parse: (s: string) => ({ url: s }), joinPath: (base: { fsPath: string }, ...p: string[]) => uri([base.fsPath, ...p].join('/')) },
    ViewColumn: { Active: -1 },
    ProgressLocation: { Notification: 15 },
    OverviewRulerLane: { Left: 1 },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startChar: number,
        readonly endLine: number,
        readonly endChar: number,
      ) {}
    },
    ConfigurationTarget: { Global: 1 },
    window: {
      createWebviewPanel: () => ({
        iconPath: undefined,
        visible: true,
        reveal() {},
        onDidDispose: event(),
        onDidChangeViewState: event(),
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (u: unknown) => u,
          postMessage: async (m: unknown) => void h.posted.push(m),
          onDidReceiveMessage: (fn: (m: unknown) => Promise<void>) => {
            h.onMessage = fn;
            return { dispose() {} };
          },
        },
      }),
      showWarningMessage: async (...args: unknown[]) => {
        h.warnings.push(args);
        return h.warningAnswer;
      },
      showInformationMessage: async (...args: unknown[]) => {
        h.infos.push(args);
        return h.infoAnswer;
      },
      showErrorMessage: async (...args: unknown[]) => void h.warnings.push(['error', ...args]),
      setStatusBarMessage() {},
      withProgress: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: event(),
      showTextDocument: async (uri: { gitUri: string }) => {
        const editor = {
          document: { uri: { toString: () => uri.gitUri } },
          setDecorations: (_d: unknown, ranges: unknown[]) => void h.commands.push(['decorate', uri, ranges]),
        };
        h.commands.push(['showTextDocument', uri]);
        return editor;
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => {} }),
      onDidChangeConfiguration: event(),
      onDidCloseTextDocument: event(),
    },
    commands: { executeCommand: async (...args: unknown[]) => void h.commands.push(args) },
    env: { clipboard: { writeText: async () => {} }, openExternal: async (u: unknown) => void h.commands.push(['openExternal', u]) },
  };
});

const { GraphPanel } = await import('../src/webview/panel');
const { registerAdditionsView } = await import('../src/diff/diffs');
registerAdditionsView({ subscriptions: [] } as never);

let repo: TestRepo;
afterEach(() => {
  repo?.dispose();
  h.posted.length = 0;
  h.commands.length = 0;
  h.warnings.length = 0;
});

function open() {
  const api = {
    git: { path: 'git' },
    repositories: [],
    onDidOpenRepository: () => ({ dispose() {} }),
    onDidCloseRepository: () => ({ dispose() {} }),
    toGitUri: (u: { fsPath: string }, ref: string) => {
      const gitUri = `${u.fsPath}@${ref}`;
      // Like a real Uri, toString identifies it (non-enumerable so toEqual ignores it).
      return Object.defineProperty({ gitUri }, 'toString', { value: () => gitUri });
    },
  };
  const repository = { rootUri: { fsPath: repo.dir }, state: { onDidChange: () => ({ dispose() {} }) } };
  const store = new Map<string, unknown>();
  const globalState = { get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => void store.set(k, v) };
  GraphPanel.show({ extensionUri: { fsPath: '/ext' }, globalState } as never, api as never, repository as never);
}
const send = (m: WebviewMessage) => h.onMessage!(m);
const last = <T extends HostMessage['type']>(type: T) =>
  h.posted.filter((m) => (m as HostMessage).type === type).at(-1) as Extract<HostMessage, { type: T }>;

describe('GraphPanel', () => {
  it('loads the graph, lists files, opens diffs and rebases on drop', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    const m2 = repo.commit('m2');
    repo.checkout('-b', 'feat', 'HEAD~1');
    const f1 = repo.commit('f1');
    repo.checkout('main');
    open();

    await send({ type: 'ready' });
    const graph = last('graph');
    expect(graph.raw.branches.map((b) => b.name)).toEqual(['feat']);
    expect(graph.rebase).toBeNull();
    expect(graph.settings.headerHeight).toBe(120);

    await send({ type: 'setHeaderHeight', height: 180 });
    await send({ type: 'refresh' });
    expect(last('graph').settings.headerHeight).toBe(180);

    await send({ type: 'listFiles', shas: [f1] });
    expect(last('files')).toMatchObject({ left: repo.rev('main~1'), right: f1 });
    expect(last('files').files).toEqual([
      { status: 'A', path: 'f1.txt', stats: { added: 1, deleted: 0, modified: 0, binary: false } },
    ]);

    // An added file has no "before" side: it opens against an empty document, not a missing git path.
    await send({ type: 'openDiff', shas: [f1], file: { status: 'A', path: 'f1.txt' } });
    let [cmd, left, right] = h.commands.at(-1)!;
    expect(cmd).toBe('vscode.diff');
    expect(left).toEqual({ empty: 'git-lanes-empty:/f1.txt' });
    expect(right).toEqual({ gitUri: `${repo.dir}/f1.txt@${f1}` });

    await send({ type: 'openDiff', shas: [f1], file: { status: 'M', path: 'f1.txt' } });
    [, left, right] = h.commands.at(-1)!;
    expect(left).toEqual({ gitUri: `${repo.dir}/f1.txt@${repo.rev('main~1')}` });

    await send({ type: 'openDiff', shas: [f1], file: { status: 'D', path: 'f1.txt' } });
    [, left, right] = h.commands.at(-1)!;
    expect(right).toEqual({ empty: 'git-lanes-empty:/f1.txt' });

    // A purely additive change opens inline: the new version alone, added lines highlighted.
    const stats = { added: 1, deleted: 0, modified: 0, binary: false };
    await send({ type: 'openDiff', shas: [f1], file: { status: 'A', path: 'f1.txt', stats } });
    expect(h.warnings.filter((w) => w[0] === 'error')).toEqual([]);
    expect(h.commands.at(-2)).toEqual(['showTextDocument', { gitUri: `${repo.dir}/f1.txt@${f1}` }]);
    expect(h.commands.at(-1)).toEqual(['decorate', { gitUri: `${repo.dir}/f1.txt@${f1}` }, [{ startLine: 0, startChar: 0, endLine: 0, endChar: 0 }]]);

    await send({ type: 'openAll', shas: [f1, repo.rev('main~1')] }); // apply f1 onto main~1
    expect(h.commands.at(-1)![0]).toBe('vscode.changes');
    // Multi-diff takes undefined for a missing side.
    const resources: unknown[] = [[expect.objectContaining({ fsPath: `${repo.dir}/f1.txt` }), undefined, { gitUri: `${repo.dir}/f1.txt@${f1}` }]];
    expect(h.commands.at(-1)![2]).toEqual(resources);

    await send({ type: 'checkout', ref: 'feat' });
    expect(repo.sh('symbolic-ref', '--short', 'HEAD')).toBe('feat');
    expect(last('graph').raw.head.branch).toBe('feat');
    await send({ type: 'checkout', ref: 'main' });

    h.warningAnswer = undefined; // user cancels the confirm dialog
    await send({ type: 'rebase', branch: 'feat', target: m2 });
    expect(repo.rev('feat~1')).not.toBe(m2);

    h.warningAnswer = 'Rebase';
    await send({ type: 'rebase', branch: 'feat', target: m2 });
    expect(String(h.warnings.at(-1)![0])).toBe('Rebase feat?');
    expect(repo.rev('feat~1')).toBe(m2);
    expect(last('graph').raw.commits[repo.rev('feat')]).toBeDefined();
  });

  it('offers to open the worktree or detach when a branch is checked out elsewhere', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.checkout('main');
    const wt = `${repo.dir}-wt`;
    repo.sh('worktree', 'add', '-q', wt, 'feat');
    try {
      open();
      await send({ type: 'ready' });

      h.infoAnswer = 'Open Worktree';
      await send({ type: 'checkout', ref: 'feat' });
      expect(String(h.infos.at(-1)![0])).toMatch(/feat is checked out in another worktree/);
      expect(h.commands.at(-1)![0]).toBe('vscode.openFolder');
      expect(repo.sh('symbolic-ref', '--short', 'HEAD')).toBe('main');

      h.infoAnswer = 'Check Out Detached';
      await send({ type: 'checkout', ref: 'feat' });
      expect(repo.rev('HEAD')).toBe(f1);
      expect(last('graph').raw.head.branch).toBeUndefined();
    } finally {
      h.infoAnswer = undefined;
      repo.sh('worktree', 'remove', '--force', wt);
    }
  });

  it('pushes with upstream, reports rejection, and force-pushes with lease', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    const remote = `${repo.dir}-remote.git`;
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    // A pre-receive-free hook that prints a link, like GitLab's merge request hint.
    const { writeFileSync, chmodSync, rmSync } = await import('node:fs');
    writeFileSync(`${remote}/hooks/post-receive`, '#!/bin/sh\necho "To create a merge request, visit:"\necho "  https://example.com/mr/new"\n');
    chmodSync(`${remote}/hooks/post-receive`, 0o755);
    repo.sh('remote', 'add', 'origin', remote);
    repo.checkout('-b', 'feat');
    repo.commit('f1');
    try {
      open();
      await send({ type: 'ready' });
      expect(last('graph').raw.remotes).toEqual(['origin']);

      h.infoAnswer = 'Open Link';
      await send({ type: 'push', branch: 'feat', remote: 'origin', setUpstream: true, mode: 'normal' });
      expect(repo.sh('rev-parse', '--abbrev-ref', 'feat@{upstream}')).toBe('origin/feat');
      expect(String(h.infos.at(-1)![0])).toBe('Pushed feat to origin.');
      expect(h.commands.at(-1)).toEqual(['openExternal', { url: 'https://example.com/mr/new' }]);
      expect(last('graph').raw.branches.find((b) => b.name === 'feat')!.upstreamRemote).toBe('origin');
      h.infoAnswer = undefined;

      // Rewrite history locally: a normal push is rejected with a hint, force-with-lease succeeds.
      repo.sh('commit', '-q', '--amend', '-m', 'f1 amended');
      await send({ type: 'push', branch: 'feat', remote: 'origin', setUpstream: true, mode: 'normal' });
      expect(String(h.warnings.at(-1)![1])).toMatch(/Push failed.*Force with lease/);
      expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'feat'], { encoding: 'utf8' }).trim()).toBe('f1');

      await send({ type: 'push', branch: 'feat', remote: 'origin', setUpstream: true, mode: 'forceWithLease' });
      expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'feat'], { encoding: 'utf8' }).trim()).toBe('f1 amended');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('deletes a branch only after confirmation, and can undo', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.checkout('main');
    open();
    await send({ type: 'ready' });
    const exists = (b: string) => repo.sh('branch', '--list', b) !== '';

    h.warningAnswer = undefined; // cancel
    await send({ type: 'deleteBranch', branch: 'feat' });
    expect(String(h.warnings.at(-1)![0])).toBe('Delete branch feat?');
    expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/1 commit is on neither main\. After deleting/);
    expect(exists('feat')).toBe(true);

    h.warningAnswer = 'Delete';
    h.infoAnswer = 'Undo';
    await send({ type: 'deleteBranch', branch: 'feat' });
    expect(String(h.infos.at(-1)![0])).toMatch(/Deleted branch feat/);
    expect(repo.rev('feat')).toBe(f1); // undone

    h.infoAnswer = undefined;
    await send({ type: 'deleteBranch', branch: 'feat' });
    expect(exists('feat')).toBe(false);
    expect(last('graph').raw.branches.map((b) => b.name)).not.toContain('feat');

    // The checked-out branch is refused without asking.
    const before = h.warnings.length;
    await send({ type: 'deleteBranch', branch: 'main' });
    expect(String(h.warnings.at(-1)![0])).toMatch(/main is checked out/);
    expect(h.warnings.length).toBe(before + 1);
    expect(exists('main')).toBe(true);
    h.warningAnswer = 'Rebase';
  });

  it("counts a branch's pushed commits as safe when deleting it", async () => {
    repo = new TestRepo();
    repo.commit('m1');
    const remote = `${repo.dir}-remote.git`;
    const { execFileSync } = await import('node:child_process');
    const { rmSync } = await import('node:fs');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    repo.sh('remote', 'add', 'origin', remote);
    repo.checkout('-b', 'feat');
    repo.commit('f1');
    repo.commit('f2');
    repo.sh('push', '-q', '-u', 'origin', 'feat');
    repo.checkout('-b', 'nolink');
    repo.sh('push', '-q', 'origin', 'nolink'); // on the remote, but no upstream configured
    repo.checkout('main');
    const detail = () => (h.warnings.at(-1)![1] as { detail: string }).detail;
    try {
      open();
      await send({ type: 'ready' });
      h.warningAnswer = undefined; // look at the dialog only

      await send({ type: 'deleteBranch', branch: 'feat' });
      expect(detail()).toMatch(/2 commits aren't on main, but they're all on origin\/feat, so nothing is lost/);
      expect(detail()).toMatch(/origin\/feat still exists on origin and is not deleted \(it has work that isn't on main\)/);
      expect(h.warnings.at(-1)!.slice(2)).toEqual(['Delete']); // no remote deletion offered for unmerged work

      await send({ type: 'deleteBranch', branch: 'nolink' });
      expect(detail()).toMatch(/they're all on origin\/nolink/);

      repo.checkout('feat');
      repo.commit('f3 unpushed');
      repo.checkout('main');
      await send({ type: 'refresh' });
      await send({ type: 'deleteBranch', branch: 'feat' });
      expect(detail()).toMatch(/1 commit is on neither main nor origin\/feat\. After deleting, it can only be recovered/);
    } finally {
      h.warningAnswer = 'Rebase';
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('offers to delete a worktree together with its branch, and undo restores both', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.sh('branch', 'wtb');
    const wt = `${repo.dir}-wt`;
    repo.sh('worktree', 'add', '-q', wt, 'wtb');
    const { existsSync, writeFileSync, rmSync } = await import('node:fs');
    const exists = (b: string) => repo.sh('branch', '--list', b) !== '';
    try {
      open();
      await send({ type: 'ready' });

      // Uncommitted work in the worktree is called out; cancel leaves everything alone.
      writeFileSync(`${wt}/scratch.txt`, 'wip\n');
      h.warningAnswer = undefined;
      await send({ type: 'deleteBranch', branch: 'wtb' });
      expect(String(h.warnings.at(-1)![0])).toBe('wtb is checked out in a worktree. Delete the worktree and the branch?');
      expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/deletes the folder .*-wt[\s\S]*changes in 1 file, which will be lost/);
      expect(existsSync(wt) && exists('wtb')).toBe(true);

      // Confirm: both go (forced past the uncommitted file); Undo brings both back.
      h.warningAnswer = 'Delete Worktree and Branch';
      h.infoAnswer = 'Undo';
      await send({ type: 'deleteBranch', branch: 'wtb' });
      expect(String(h.infos.at(-1)![0])).toMatch(/Deleted branch wtb and its worktree/);
      expect(exists('wtb')).toBe(true);
      expect(repo.sh('worktree', 'list')).toContain('[wtb]');

      // Confirm without undo.
      h.infoAnswer = undefined;
      await send({ type: 'deleteBranch', branch: 'wtb' });
      expect(exists('wtb')).toBe(false);
      expect(existsSync(wt)).toBe(false);
    } finally {
      h.warningAnswer = 'Rebase';
      h.infoAnswer = undefined;
      rmSync(wt, { recursive: true, force: true });
      repo.sh('worktree', 'prune');
    }
  });

  it('cleans up a missing worktree folder when deleting its branch', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.sh('branch', 'gone');
    const wt = `${repo.dir}-gone`;
    repo.sh('worktree', 'add', '-q', wt, 'gone');
    const { rmSync } = await import('node:fs');
    rmSync(wt, { recursive: true, force: true }); // folder deleted behind git's back
    try {
      open();
      await send({ type: 'ready' });
      h.warningAnswer = 'Delete Worktree and Branch';
      await send({ type: 'deleteBranch', branch: 'gone' });
      expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/no longer exists; git's record of it will be cleaned up/);
      expect(repo.sh('branch', '--list', 'gone')).toBe('');
      expect(repo.sh('worktree', 'list')).not.toContain('-gone');
    } finally {
      h.warningAnswer = 'Rebase';
    }
  });

  it('merges a branch into the current one after confirmation, with undo and conflict state', async () => {
    repo = new TestRepo();
    repo.commit('base', 'f.txt', 'base');
    repo.checkout('-b', 'feat');
    const f1 = repo.commit('f1');
    repo.checkout('main');
    const m1 = repo.rev('main');
    open();
    await send({ type: 'ready' });

    h.warningAnswer = 'Merge';
    h.infoAnswer = 'Undo';
    await send({ type: 'merge', ref: 'feat' });
    expect(String(h.warnings.at(-1)![0])).toBe('Merge feat into main?');
    expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/Brings 1 commit from feat into main\.[\s\S]*fast-forward/);
    expect(h.warnings.at(-1)!.slice(2)).toEqual(['Merge', 'Merge (always create a merge commit)']);
    expect(repo.rev('main')).toBe(m1); // undone

    h.warningAnswer = 'Merge (always create a merge commit)';
    h.infoAnswer = undefined;
    await send({ type: 'merge', ref: 'feat' });
    expect(repo.sh('log', '-1', '--format=%P', 'main').split(' ')).toEqual([m1, f1]);

    // A conflicting merge leaves a merge in progress, reported to the webview for the banner.
    repo.checkout('-b', 'other', m1);
    repo.commit('other', 'f.txt', 'other side');
    repo.checkout('main');
    repo.commit('main edit', 'f.txt', 'main side');
    await send({ type: 'refresh' });
    h.warningAnswer = 'Merge';
    await send({ type: 'merge', ref: 'other' });
    expect(last('graph').merging).toEqual({ message: "Merge branch 'other'" });
    await send({ type: 'mergeStep', step: 'abort' });
    expect(last('graph').merging).toBeNull();
    h.warningAnswer = 'Rebase';
  });

  it('checks the server when deleting: deletes the remote too if asked, or cleans up a stale reference', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    const remote = `${repo.dir}-remote.git`;
    const { execFileSync } = await import('node:child_process');
    const { rmSync } = await import('node:fs');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    repo.sh('remote', 'add', 'origin', remote);
    repo.sh('push', '-q', 'origin', 'main');
    repo.sh('update-ref', 'refs/remotes/origin/HEAD', repo.rev('main'));
    // Two branches already on main (nothing to lose), both pushed.
    repo.sh('branch', 'done-a');
    repo.sh('branch', 'done-b');
    repo.sh('push', '-q', '-u', 'origin', 'done-a', 'done-b');
    // done-b gets deleted on the server behind our back (like GitLab after a merge).
    execFileSync('git', ['--git-dir', remote, 'branch', '-D', 'done-b']);
    const onServer = (b: string) => execFileSync('git', ['--git-dir', remote, 'branch', '--list', b], { encoding: 'utf8' }).trim() !== '';
    const tracking = (b: string) => repo.sh('for-each-ref', `refs/remotes/origin/${b}`) !== '';
    try {
      open();
      await send({ type: 'ready' });

      h.warningAnswer = 'Delete Local and Remote';
      h.infoAnswer = 'Undo';
      await send({ type: 'deleteBranch', branch: 'done-a' });
      expect(h.warnings.at(-1)!.slice(2)).toEqual(['Delete Local Only', 'Delete Local and Remote']);
      expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/origin\/done-a still exists on origin\. You can delete it too/);
      expect(String(h.infos.at(-1)![0])).toMatch(/Deleted branch done-a and origin\/done-a/);
      // Undo put both back.
      expect(onServer('done-a') && tracking('done-a')).toBe(true);

      h.infoAnswer = undefined;
      await send({ type: 'deleteBranch', branch: 'done-a' });
      expect(onServer('done-a')).toBe(false);
      expect(tracking('done-a')).toBe(false);

      h.warningAnswer = 'Delete';
      await send({ type: 'deleteBranch', branch: 'done-b' });
      expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/origin\/done-b was already deleted on origin.*leftover local reference will be removed/);
      expect(h.warnings.at(-1)!.slice(2)).toEqual(['Delete']);
      expect(tracking('done-b')).toBe(false);
    } finally {
      h.warningAnswer = 'Rebase';
      h.infoAnswer = undefined;
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("says when it can't reach the remote, and deletes only locally", async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.sh('remote', 'add', 'origin', '/nonexistent/remote.git');
    repo.sh('branch', 'x');
    repo.sh('update-ref', 'refs/remotes/origin/x', repo.rev('x'));
    try {
      open();
      await send({ type: 'ready' });
      h.warningAnswer = undefined;
      await send({ type: 'deleteBranch', branch: 'x' });
      expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/Couldn't reach origin to check origin\/x; only the local branch is deleted/);
    } finally {
      h.warningAnswer = 'Rebase';
    }
  });

  it('reports squash-merged branches and says so when deleting one', async () => {
    repo = new TestRepo();
    repo.commit('m1');
    repo.checkout('-b', 'feat');
    repo.commit('f1');
    repo.commit('f2');
    repo.checkout('main');
    repo.sh('merge', '--squash', 'feat');
    repo.sh('commit', '-q', '-m', 'squashed feat');
    open();
    await send({ type: 'ready' });
    // Detection runs after the graph is posted.
    for (let i = 0; i < 100 && !last('merged'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(last('merged').merged).toEqual({ feat: { tip: repo.rev('feat'), how: 'squash', trunkCommit: repo.rev('main') } });

    h.warningAnswer = undefined; // just look at the dialog
    await send({ type: 'deleteBranch', branch: 'feat' });
    expect((h.warnings.at(-1)![1] as { detail: string }).detail).toMatch(/squash-merged as [0-9a-f]{10}\), so nothing is lost/);
    h.warningAnswer = 'Rebase';
  });

  it('shows rebase state on conflict and aborts from the banner', async () => {
    repo = new TestRepo();
    repo.commit('m1', 'f.txt', 'base');
    const m2 = repo.commit('m2', 'f.txt', 'main');
    repo.checkout('-b', 'feat', 'HEAD~1');
    const f1 = repo.commit('f1', 'f.txt', 'feat');
    repo.checkout('main');
    open();
    await send({ type: 'ready' });
    await send({ type: 'rebase', branch: 'feat', target: m2 });
    expect(last('graph').rebase).toMatchObject({ branch: 'feat' });
    await send({ type: 'rebaseStep', step: 'abort' });
    expect(last('graph').rebase).toBeNull();
    expect(repo.rev('feat')).toBe(f1);
  });
});
