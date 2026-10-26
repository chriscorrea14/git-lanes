# Git Lanes

A compact git graph for VS Code: every local branch gets its own vertical lane, and rows are
packed so independent commits on different branches share a row.

## Install

1. Download the latest `git-lanes-*.vsix` from the [Releases page](https://github.com/chriscorrea14/git-lanes/releases).
2. In VS Code, run **Extensions: Install from VSIX…** from the Command Palette and pick the file.
3. Reload the window.

Requires VS Code 1.90+ and `git` on your PATH. Pushing and deleting remote branches use your normal git
credentials (SSH keys or a credential helper); Git Lanes never prompts for passwords.

## Use

Run **Git Lanes: Show Graph** from the Command Palette, or click the branch icon in the Source
Control title bar.

| Do | To |
| --- | --- |
| Hover a commit | See SHA, full message, author, date, refs |
| Click a commit | Pin that popover. Each branch the commit is on gets a row: `name: [Checkout] [Push] [Merge into current] [Delete]` (confirmations and Undo where it matters); at the remote trunk's tip you can merge it into the current branch and list changed files with line counts (`+added ~modified −deleted`); click a file for its diff |
| Click the selected commit again | Close its popover and details |
| Double-click a commit | Check it out: the local branch whose tip it is, otherwise a detached HEAD at that commit |
| Ctrl/⌘-click a second commit | Compare the two, as if applying the first commit you clicked onto the second (the second is the base); **Open all changes** opens the multi-file diff. Ctrl/⌘-click a selected commit to drop it |
| Escape | Close the popover and details pane (or cancel a drag in progress) |
| Drag a branch commit onto another commit | Rebase that whole branch (fork point → tip) onto the target, after a confirm dialog. **Undo** is offered afterwards |
| Click `… N commits …` | Expand collapsed trunk history |
| Drag the bottom edge of the branch-name header | Resize it so long names fit; double-click that edge to fit the longest name (remembered across sessions) |

**Push** opens a dialog: remote (defaults to the branch's upstream remote, else `origin`), **Set upstream**
(on by default) and mode (Normal, Force with lease, Force). If the remote prints a link (e.g. GitLab's
"create merge request"), the success message offers **Open Link**. Pushes never prompt for credentials,
so use SSH keys or a credential helper.

**Merge into current** asks first, says how many commits come in and whether it's a fast-forward (with an option to always create a merge commit), stashes uncommitted changes, and offers **Undo**. A conflicted merge shows a banner with **Continue / Abort / Open Source Control**.

During a conflicted rebase, a banner offers **Continue / Skip / Abort / Open Source Control**.

Files whose change only adds lines (including new files) open inline: the new version alone, read-only,
with the added lines highlighted. Everything else opens in the normal side-by-side diff.

Line counts come from `git diff -U0`: within each change block, deleted lines paired with added
lines count as *modified* (`~`); the rest are pure additions (`+`) or deletions (`−`).

### Reading the graph

- Lane 0 is the trunk (`origin/HEAD`, falling back to `main`/`master`). Feature lanes show only
  commits not on trunk; a stacked branch sits right of the branch it is built on.
- Hollow dots are commits not yet pushed to the branch's upstream; a dashed ring marks the commit
  the upstream points at. Headers show `↑ahead ↓behind`.
- `✓ merged` after a branch name means its changes are already on trunk even though its commits aren't:
  it was squash-merged (its combined change matches one trunk commit, including GitLab's squash + merge
  commit) or rebase-merged (every commit has an equivalent on trunk). Deleting it then loses nothing,
  and the delete dialog says so. Detection runs after the graph draws and is cached.
- Commits merged into a branch from elsewhere get an unlabeled *merged* lane, unless their changes are
  already on trunk (squash- or rebase-merged there too). Then the lane isn't drawn, and the merge commit's
  popup says so. Uncheck **Merged lanes** in the toolbar (`gitLanes.showMergedLanes`) to hide all of them:
  merges then show as diamonds only, and hovering one says how many commits it brought in.
- `⎇` after a branch name means it is checked out in another worktree (hover for the path). Double-clicking
  it offers to open that worktree or check out its commit detached; rebase it from that worktree.
- Diamonds are merge commits; dashed edges are merge parents. Commits merged in from a branch
  that no longer exists get an unlabeled *merged* lane.
- The right-hand column shows `git log --first-parent HEAD` subjects, with trunk subjects dimmed
  on other rows, plus labels for refs without their own lane.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `gitLanes.alignment` | `top` | `top`: all branch tips at the top. `forkPoint`: each branch sits right above where it forked |
| `gitLanes.trunk` | `""` | Trunk ref; empty auto-detects |
| `gitLanes.trunkCommits` | `50` | Minimum trunk commits loaded (more are loaded to reach old fork points) |
| `gitLanes.showMergedLanes` | `true` | Draw lanes for commits merged in from elsewhere; off = merges as diamonds only |
| `gitLanes.subjects` | `head` | `none` hides the message column |

## Limitations

- Branches stacked on the one you drag do not move with it (git ≥ 2.38 `--update-refs` could do this later).
- Rebasing flattens merge commits inside the dragged branch (plain `git rebase`).
- Trunk commits are not draggable.

## Troubleshooting

**Output → Git Lanes** logs every action from the graph, every git command that changes something
(with errors), and each reload. Set the log level to Debug to also see read-only git commands.

## Release

1. Bump `version` in `package.json` (e.g. `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The **Release** workflow tests, builds the `.vsix`, and publishes it as a GitHub Release.

## Develop

```bash
npm install
npm test            # unit + temp-repo integration tests
npm run build       # typecheck + bundle to dist/
npm run package     # build git-lanes-<version>.vsix
```

Press F5 in VS Code to launch an Extension Development Host. `scripts/make-demo-repo.sh [dir]`
builds a repo with stacked, merged, pushed and conflicting branches to try it on.

To iterate on the webview without VS Code: `npm run dev:dump -- <repo> > dev/graph.json`, serve the
project root over HTTP and open `dev/harness.html`.
