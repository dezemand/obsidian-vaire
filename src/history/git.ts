// Git adapter for the History section's "git" source (BRANCHES.md `feat/node-history`).
// Desktop-only (uses Node's child_process), but intentionally does not import `obsidian` so it
// can be unit-tested with a fake `exec`, mirroring src/cli.ts's `VaireCli`/`ExecFn` split.
//
// `git` is assumed to be on PATH the same way `vaire` is: GUI apps on macOS launch with a
// minimal PATH, so every spawn reuses `childEnv()` (src/cli.ts) rather than duplicating the
// PATH-prepend logic.

import { execFile } from 'node:child_process';
import { childEnv } from '../cli';
import { GIT_LOG_FIELD_SEP, describeWorkingTreeStatus, parseDiff, parseGitLog, type DiffLine, type GitLogEntry } from './pure';

export class GitError extends Error {
  /** `not-a-repo`: `absRoot` isn't inside a git working tree. `spawn`: git failed to run or
   *  exited non-zero (message is git's own stderr, tailed). `timeout`: the command exceeded its
   *  timeout and was killed. */
  kind: 'not-a-repo' | 'spawn' | 'timeout';
  constructor(message: string, kind: GitError['kind']) {
    super(message);
    this.name = 'GitError';
    this.kind = kind;
  }
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Set when the child was killed for exceeding its timeout. */
  timedOut?: boolean;
}

export type GitExecFn = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
) => Promise<GitExecResult>;

function defaultExec(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: opts.env, maxBuffer: opts.maxBuffer, timeout: opts.timeout, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const errWithCode = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const code = typeof errWithCode.code === 'number' ? errWithCode.code : 1;
          const timedOut = Boolean(errWithCode.killed && errWithCode.signal === 'SIGTERM');
          resolve({ stdout: stdout ?? '', stderr: stderr || error.message, code, timedOut });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        }
      },
    );
  });
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024; // 16 MiB — git log/show output is small text, never binary here
const LOG_LIMIT = 30;
const GIT_LOG_FORMAT = `%H${GIT_LOG_FIELD_SEP}%h${GIT_LOG_FIELD_SEP}%an${GIT_LOG_FIELD_SEP}%aI${GIT_LOG_FIELD_SEP}%s`;

export interface GitAdapterOptions {
  /** Fake spawner for tests; defaults to a real `execFile('git', ...)`. */
  exec?: GitExecFn;
  timeoutMs?: number;
}

function tail(text: string, lines = 20): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.split('\n').slice(-lines).join('\n').trim();
}

async function run(cwd: string, args: string[], opts: GitAdapterOptions): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result: GitExecResult;
  try {
    result = await exec(args, { cwd, env: childEnv(), maxBuffer: MAX_BUFFER, timeout });
  } catch (err) {
    const e = err as Error;
    throw new GitError(e.message || 'failed to spawn git', 'spawn');
  }
  if (result.timedOut) {
    throw new GitError(`git ${args[0]} timed out after ${timeout}ms`, 'timeout');
  }
  if (result.code !== 0) {
    throw new GitError(tail(result.stderr) || `git exited with code ${result.code}`, 'spawn');
  }
  return result.stdout;
}

/** Whether `absRoot` is inside a git working tree (`git rev-parse --is-inside-work-tree`).
 *  Never throws — any failure (not a repo, git missing, timeout) reads as `false`, since every
 *  caller's only question is "should the git history sub-section render at all". */
export async function isGitRepo(absRoot: string, opts: GitAdapterOptions = {}): Promise<boolean> {
  try {
    const stdout = await run(absRoot, ['rev-parse', '--is-inside-work-tree'], opts);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * `git log --follow --format=<sep-delimited> -n 30 -- <relPath>`, parsed into `GitLogEntry[]`
 * (newest first, as `git log` already orders them). `--follow` keeps history across a rename;
 * `relPath` is relative to `absRoot` (the package root passed as `cwd`), matching what
 * `packageRelativePath` produces. Throws `GitError` (kind `spawn`) if `absRoot` isn't a git
 * repo at all — callers should check `isGitRepo` first to render a clean notice instead.
 */
export async function gitLog(absRoot: string, relPath: string, opts: GitAdapterOptions = {}): Promise<GitLogEntry[]> {
  const stdout = await run(
    absRoot,
    ['log', '--follow', `--format=${GIT_LOG_FORMAT}`, '-n', String(LOG_LIMIT), '--', relPath],
    opts,
  );
  return parseGitLog(stdout);
}

export interface GitShowResult {
  /** The full `git show` output (commit header + `--stat` summary + the file's unified diff). */
  raw: string;
  /** `raw`, pre-split into colorable lines — see `parseDiff`. */
  lines: DiffLine[];
}

/**
 * `git show --stat <hash> -- <relPath>`: the commit header (author/date/subject), the diffstat
 * summary, and the unified diff for just this file (git scopes the patch to the given pathspec).
 * Returned as both the raw text and pre-split `DiffLine`s so the diff modal can render a colored
 * `pre` without re-parsing.
 */
export async function gitShow(
  absRoot: string,
  hash: string,
  relPath: string,
  opts: GitAdapterOptions = {},
): Promise<GitShowResult> {
  const raw = await run(absRoot, ['show', '--stat', hash, '--', relPath], opts);
  return { raw, lines: parseDiff(raw) };
}

/**
 * `git status --porcelain -- <relPath>`, reduced to a short label ("modified, not committed") or
 * `null` when the file is clean — see `describeWorkingTreeStatus`. This is what surfaces
 * uncommitted work in the git history list, since `git log` alone never sees it.
 */
export async function gitStatus(absRoot: string, relPath: string, opts: GitAdapterOptions = {}): Promise<string | null> {
  const stdout = await run(absRoot, ['status', '--porcelain', '--', relPath], opts);
  return describeWorkingTreeStatus(stdout);
}
