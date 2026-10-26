import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: RunResult,
  ) {
    super(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed (${result.code})`);
  }
}

export type GitLogger = (args: string[], result: RunResult, ms: number) => void;

export class Git {
  constructor(
    readonly cwd: string,
    readonly gitPath = 'git',
    private readonly log?: GitLogger,
  ) {}

  /** Runs git and returns the result without throwing on a non-zero exit. */
  exec(args: string[], env?: Record<string, string>, input?: string): Promise<RunResult> {
    const start = Date.now();
    return new Promise<RunResult>((resolve) => {
      const child = execFile(
        this.gitPath,
        args,
        { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ stdout, stderr, code });
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    }).then((result) => {
      this.log?.(args, result, Date.now() - start);
      return result;
    });
  }

  async run(args: string[], env?: Record<string, string>): Promise<string> {
    const result = await this.exec(args, env);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout;
  }

  /** Like run, but returns undefined instead of throwing. */
  async tryRun(args: string[]): Promise<string | undefined> {
    const result = await this.exec(args);
    return result.code === 0 ? result.stdout : undefined;
  }
}
