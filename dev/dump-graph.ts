// Dumps a repo's RawGraph as a `graph` host message for dev/harness.html.
// Usage: npm run dev:dump -- <repo-dir> > dev/graph.json
import { Git } from '../src/git/gitCli';
import { loadRepo } from '../src/git/repoData';
import { rebaseState } from '../src/rebase/execute';

const dir = process.argv[2] ?? process.cwd();
const git = new Git(dir);
const [raw, rebase] = await Promise.all([loadRepo(git, { trunkCommits: 50 }), rebaseState(git)]);
process.stdout.write(
  JSON.stringify({ type: 'graph', raw, settings: { alignment: 'top', subjects: 'head', headerHeight: 120, showMergedLanes: true }, rebase: rebase ?? null, repoName: dir.split('/').pop() }),
);
