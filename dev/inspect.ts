import { Git } from '../src/git/gitCli';
import { loadRepo } from '../src/git/repoData';
import { computeLayout } from '../src/graph/layout';
const raw = await loadRepo(new Git(process.argv[2]), { trunkCommits: 50 });
const l = computeLayout(raw, { alignment: 'top' });
for (const lane of l.lanes.slice(0, 45)) {
  const c = raw.commits[lane.commits[0]];
  console.log(lane.index, lane.kind, lane.name ?? '', lane.commits.length, '|', c.subject.slice(0, 60));
}
