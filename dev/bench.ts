// Times loadRepo + computeLayout on a repo (read-only). Usage: node dist/bench.mjs <repo>
import { Git } from '../src/git/gitCli';
import { loadRepo } from '../src/git/repoData';
import { computeLayout } from '../src/graph/layout';

const git = new Git(process.argv[2] ?? process.cwd());
let t = performance.now();
const raw = await loadRepo(git, { trunkCommits: 50 });
const loadMs = performance.now() - t;
t = performance.now();
const top = computeLayout(raw, { alignment: 'top' });
const fork = computeLayout(raw, { alignment: 'forkPoint' });
const layoutMs = performance.now() - t;
console.log({
  trunk: raw.trunk.name,
  localBranches: raw.branches.length,
  lanes: top.lanes.length,
  columns: top.columnCount,
  columnsForkPoint: fork.columnCount,
  commits: Object.keys(raw.commits).length,
  trunkShown: raw.trunk.commits.length,
  rowsTop: top.rowCount,
  rowsForkPoint: fork.rowCount,
  gaps: top.gaps.length,
  loadMs: Math.round(loadMs),
  layoutMs: Math.round(layoutMs),
});
