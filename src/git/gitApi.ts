// Minimal subset of the built-in vscode.git extension API (extensions/git/src/api/git.d.ts).
import type { Event, Uri } from 'vscode';

export interface Repository {
  readonly rootUri: Uri;
  readonly state: { readonly onDidChange: Event<void> };
}

export interface API {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
}

export interface GitExtension {
  getAPI(version: 1): API;
}
