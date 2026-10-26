import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/git/gitCli';

/** A throwaway git repo with deterministic commit timestamps. */
export class TestRepo {
  readonly dir = mkdtempSync(join(tmpdir(), 'git-lanes-test-'));
  readonly git = new Git(this.dir);
  private clock = 1_700_000_000;

  constructor() {
    this.sh('init', '-q', '-b', 'main');
    this.sh('config', 'user.name', 'Test');
    this.sh('config', 'user.email', 'test@example.com');
    this.sh('config', 'commit.gpgsign', 'false');
  }

  sh(...args: string[]): string {
    const date = `${this.clock++} +0000`;
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_EDITOR: 'true' },
    }).trim();
  }

  /** Commits a change to `file` (default: a file named after the message) and returns the sha. */
  commit(message: string, file = `${message}.txt`, content = message): string {
    writeFileSync(join(this.dir, file), content + '\n');
    this.sh('add', file);
    this.sh('commit', '-q', '-m', message);
    return this.sh('rev-parse', 'HEAD');
  }

  checkout(...args: string[]): void {
    this.sh('checkout', '-q', ...args);
  }

  merge(branch: string, message: string): string {
    this.sh('merge', '-q', '--no-ff', '-m', message, branch);
    return this.sh('rev-parse', 'HEAD');
  }

  rev(ref: string): string {
    return this.sh('rev-parse', ref);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
