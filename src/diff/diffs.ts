import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Git } from '../git/gitCli';
import type { API } from '../git/gitApi';
import type { FileChange, LineStats } from '../protocol';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; ) {
    const status = parts[i++];
    if (!status) break;
    if (status[0] === 'R' || status[0] === 'C') {
      files.push({ status: status[0], oldPath: parts[i++], path: parts[i++] });
    } else {
      files.push({ status: status[0], path: parts[i++] });
    }
  }
  return files;
}

/**
 * [left, right] refs. A single commit diffs against its first parent. For two commits, in click
 * order [first, second], the second is the base: the diff shows applying the first onto it.
 */
export async function diffRefs(git: Git, shas: string[]): Promise<[string, string]> {
  if (shas.length === 2) return [shas[1], shas[0]];
  const parent = (await git.tryRun(['rev-parse', '--verify', '-q', `${shas[0]}^1`]))?.trim();
  return [parent || EMPTY_TREE, shas[0]];
}

/**
 * Per-file line stats from `git diff -U0` output, in file order. With zero context every hunk is
 * one change block: its paired deletions/additions count as modified lines, the rest as pure
 * additions or deletions.
 */
export function parseLineStats(out: string): LineStats[] {
  const stats: LineStats[] = [];
  let cur: LineStats | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { added: 0, deleted: 0, modified: 0, binary: false };
      stats.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const del = m[1] === undefined ? 1 : Number(m[1]);
      const add = m[2] === undefined ? 1 : Number(m[2]);
      const mod = Math.min(del, add);
      cur.modified += mod;
      cur.deleted += del - mod;
      cur.added += add - mod;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      cur.binary = true;
    }
  }
  return stats;
}

export async function listFiles(git: Git, shas: string[]): Promise<FileChange[]> {
  const [left, right] = await diffRefs(git, shas);
  return listFilesBetween(git, left, right);
}

export async function listFilesBetween(git: Git, left: string, right: string): Promise<FileChange[]> {
  const [names, patch] = await Promise.all([
    git.run(['diff', '-M', '--name-status', '-z', left, right, '--']),
    git.run(['diff', '-M', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', left, right, '--']),
  ]);
  const files = parseNameStatus(names);
  // Both diffs use the same rename detection, so file order matches.
  const stats = parseLineStats(patch);
  if (stats.length === files.length) files.forEach((f, i) => (f.stats = stats[i]));
  return files;
}

const short = (ref: string) => (ref === EMPTY_TREE ? 'empty' : ref.slice(0, 7));

/** Scheme for an always-empty document: the missing side of an added or deleted file. */
export const EMPTY_SCHEME = 'git-lanes-empty';

/** Keeps the file's path so the empty side gets the same name and language. */
export const emptyUri = (filePath: string) => vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${filePath}` });

/**
 * [resource, left, right]. A side that doesn't exist (an added file has no left, a deleted file no
 * right) is undefined: VS Code's git provider errors on missing paths instead of returning nothing.
 */
function uris(
  api: API,
  root: string,
  file: FileChange,
  left: string,
  right: string,
): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] {
  const rightUri = vscode.Uri.file(path.join(root, file.path));
  const leftUri = vscode.Uri.file(path.join(root, file.oldPath ?? file.path));
  return [
    rightUri,
    file.status === 'A' ? undefined : api.toGitUri(leftUri, left),
    file.status === 'D' ? undefined : api.toGitUri(rightUri, right),
  ];
}

/** 0-based [first, last] line ranges added on the new side, from `git diff -U0` output for one file. */
export function parseAddedRanges(patch: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start - 1, start - 2 + count]);
  }
  return ranges;
}

/** True when a file's change is purely additive, so an inline view is just the new file. */
export const onlyAdditions = (f: FileChange) =>
  !!f.stats && !f.stats.binary && f.stats.added > 0 && f.stats.deleted === 0 && f.stats.modified === 0;

// Added-line highlights for files opened in the additions-only inline view, by document URI.
// Decorations belong to an editor instance, so they're re-applied whenever the document is shown again.
const highlighted = new Map<string, vscode.Range[]>();
let addedLineDecoration: vscode.TextEditorDecorationType | undefined;

function decorate(editor: vscode.TextEditor): void {
  const ranges = highlighted.get(editor.document.uri.toString());
  if (ranges && addedLineDecoration) editor.setDecorations(addedLineDecoration, ranges);
}

export function registerAdditionsView(context: vscode.ExtensionContext): void {
  addedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  context.subscriptions.push(
    addedLineDecoration,
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)),
    vscode.workspace.onDidCloseTextDocument((doc) => highlighted.delete(doc.uri.toString())),
  );
}

/**
 * VS Code's inline diff mode is a single global setting, so for a purely additive change we draw
 * the equivalent ourselves: the new version, read-only, with the added lines highlighted.
 */
async function openAdditionsInline(git: Git, uri: vscode.Uri, file: FileChange, left: string, right: string): Promise<void> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const patch = await git.run(['diff', '-M', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', left, right, '--', ...paths]);
  highlighted.set(
    uri.toString(),
    parseAddedRanges(patch).map(([a, b]) => new vscode.Range(a, 0, b, 0)),
  );
  decorate(await vscode.window.showTextDocument(uri, { preview: true }));
}

export async function openDiff(api: API, git: Git, shas: string[], file: FileChange): Promise<void> {
  const [left, right] = await diffRefs(git, shas);
  const [, l, r] = uris(api, git.cwd, file, left, right);
  if (r && onlyAdditions(file)) return openAdditionsInline(git, r, file, left, right);
  const title = `${path.basename(file.path)} (${short(left)} ↔ ${short(right)})`;
  await vscode.commands.executeCommand('vscode.diff', l ?? emptyUri(file.path), r ?? emptyUri(file.path), title, {
    preview: true,
  });
}

export async function openAll(api: API, git: Git, shas: string[]): Promise<void> {
  const [left, right] = await diffRefs(git, shas);
  const files = await listFilesBetween(git, left, right);
  const resources = files.map((f) => uris(api, git.cwd, f, left, right));
  await vscode.commands.executeCommand('vscode.changes', `${short(left)} ↔ ${short(right)}`, resources);
}
