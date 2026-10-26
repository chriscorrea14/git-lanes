import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitExtension, Repository } from './git/gitApi';
import { EMPTY_SCHEME, registerAdditionsView } from './diff/diffs';
import { GraphPanel } from './webview/panel';

export function activate(context: vscode.ExtensionContext): void {
  registerAdditionsView(context);
  const log = vscode.window.createOutputChannel('Git Lanes', { log: true });
  context.subscriptions.push(
    log,
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => '' }),
    vscode.commands.registerCommand('gitLanes.show', async () => {
      const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!ext) return void vscode.window.showErrorMessage('Git Lanes needs the built-in Git extension.');
      const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
      const repo = await pickRepository(api.repositories);
      if (repo) GraphPanel.show(context, api, repo, log);
    }),
  );
}

async function pickRepository(repos: Repository[]): Promise<Repository | undefined> {
  if (repos.length === 0) {
    void vscode.window.showInformationMessage('No git repository is open.');
    return undefined;
  }
  if (repos.length === 1) return repos[0];
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const containing = active && repos.find((r) => active.startsWith(r.rootUri.fsPath + path.sep));
  const items = repos.map((r) => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repo: r }));
  if (containing) items.sort((a) => (a.repo === containing ? -1 : 0));
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Repository' }))?.repo;
}

export function deactivate(): void {}
