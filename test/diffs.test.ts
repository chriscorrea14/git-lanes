import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { parseNameStatus } = await import('../src/diff/diffs');

describe('parseNameStatus', () => {
  it('parses -z output including renames', () => {
    const out = ['M', 'a.txt', 'R087', 'old.txt', 'new.txt', 'A', 'dir/b c.txt', ''].join('\0');
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
      { status: 'A', path: 'dir/b c.txt' },
    ]);
  });
});

const { parseLineStats, listFiles } = await import('../src/diff/diffs');
const { TestRepo } = await import('./repoHelper');

describe('parseLineStats', () => {
  it('splits change blocks into modified, added and deleted', () => {
    const out = [
      'diff --git a/a.txt b/a.txt',
      '@@ -3,2 +3,5 @@ ctx', // 2 modified, 3 added
      '@@ -10 +12,0 @@', // 1 deleted
      '@@ -20 +22 @@', // 1 modified
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '@@ -0,0 +1,7 @@',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    expect(parseLineStats(out)).toEqual([
      { added: 3, deleted: 1, modified: 3, binary: false },
      { added: 7, deleted: 0, modified: 0, binary: false },
      { added: 0, deleted: 0, modified: 0, binary: true },
    ]);
  });
});

describe('listFiles', () => {
  it('attaches line stats to each file, including new files', async () => {
    const repo = new TestRepo();
    try {
      repo.commit('base', 'a.txt', ['one', 'two', 'three', 'four'].join('\n'));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${repo.dir}/a.txt`, ['one', 'TWO', 'three', 'four', 'five', 'six'].join('\n') + '\n');
      writeFileSync(`${repo.dir}/b.txt`, 'x\ny\nz\n');
      repo.sh('add', '.');
      repo.sh('commit', '-q', '-m', 'change');
      const files = await listFiles(repo.git, [repo.rev('HEAD')]);
      expect(files).toEqual([
        { status: 'M', path: 'a.txt', stats: { added: 2, deleted: 0, modified: 1, binary: false } },
        { status: 'A', path: 'b.txt', stats: { added: 3, deleted: 0, modified: 0, binary: false } },
      ]);
    } finally {
      repo.dispose();
    }
  });
});

const { diffRefs } = await import('../src/diff/diffs');

describe('diffRefs', () => {
  it('uses the second clicked commit as the base, whatever the history or dates', async () => {
    const repo = new TestRepo();
    try {
      const base = repo.commit('base');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${repo.dir}/new.txt`, 'added\n');
      repo.sh('add', 'new.txt');
      repo.sh('commit', '-q', '-m', 'rebased work', '--date=2020-01-01T00:00:00Z');
      const work = repo.rev('HEAD');
      // Clicked work, then base: apply work onto base -> new.txt added.
      expect(await diffRefs(repo.git, [work, base])).toEqual([base, work]);
      expect(await listFiles(repo.git, [work, base])).toEqual([
        { status: 'A', path: 'new.txt', stats: { added: 1, deleted: 0, modified: 0, binary: false } },
      ]);
      // Clicked base, then work: apply base onto work -> new.txt removed.
      expect(await diffRefs(repo.git, [base, work])).toEqual([work, base]);
      expect((await listFiles(repo.git, [base, work]))[0].status).toBe('D');
    } finally {
      repo.dispose();
    }
  });
});

const { parseAddedRanges, onlyAdditions } = await import('../src/diff/diffs');

describe('additions-only inline view helpers', () => {
  it('extracts 0-based added line ranges from -U0 hunks', () => {
    const patch = ['diff --git a/f b/f', '@@ -0,0 +1,3 @@', '+a', '+b', '+c', '@@ -10,0 +14 @@', '+d', '@@ -20,2 +25,0 @@'].join('\n');
    expect(parseAddedRanges(patch)).toEqual([
      [0, 2],
      [13, 13],
    ]);
  });

  it('detects purely additive changes', () => {
    const st = (added: number, deleted: number, modified: number, binary = false) => ({ status: 'M', path: 'f', stats: { added, deleted, modified, binary } });
    expect(onlyAdditions(st(5, 0, 0))).toBe(true);
    expect(onlyAdditions(st(5, 1, 0))).toBe(false);
    expect(onlyAdditions(st(5, 0, 2))).toBe(false);
    expect(onlyAdditions(st(0, 0, 0))).toBe(false);
    expect(onlyAdditions(st(0, 0, 0, true))).toBe(false);
    expect(onlyAdditions({ status: 'A', path: 'f' })).toBe(false); // no stats: fall back to a real diff
  });
});
