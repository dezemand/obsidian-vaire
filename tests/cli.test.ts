import { describe, expect, test } from 'bun:test';
import { VaireCli, VaireError, type ExecFn, type ExecResult } from '../src/cli';

interface RecordedCall {
  file: string;
  args: string[];
}

function fakeCli(handler: (args: string[]) => ExecResult | Promise<ExecResult>) {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    return handler(args);
  };
  const cli = new VaireCli(() => ({ binaryPath: '/fake/vaire' }), exec);
  return { cli, calls };
}

const ok = (obj: unknown): ExecResult => ({ stdout: JSON.stringify(obj), stderr: '', code: 0 });
const BASE = ['-o', 'json', '--no-color', '-q'];

describe('VaireCli argument construction', () => {
  test('resolve', async () => {
    const { cli, calls } = fakeCli(() =>
      ok({ id: 'concept:reference', type: 'concept', path: 'x.md', frontmatter: {}, superseded_by: null }),
    );
    await cli.resolve('/repo', 'concept:reference');
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'resolve', 'concept:reference']);
    expect(calls[0].file).toBe('/fake/vaire');
  });

  test('search with every flag', async () => {
    const { cli, calls } = fakeCli(() => ok({ query: 'q', results: [] }));
    await cli.search('/repo', 'reference graph', { type: 'concept', limit: 5, local: true, all: true, scope: 'cli:vaire' });
    expect(calls[0].args).toEqual([
      ...BASE,
      '--repo',
      '/repo',
      'search',
      'reference graph',
      '--type',
      'concept',
      '--limit',
      '5',
      '--local',
      '--all',
      '--scope',
      'cli:vaire',
    ]);
  });

  test('suggest with every flag', async () => {
    const { cli, calls } = fakeCli(() => ok({ descriptor: 'd', suggestions: [], count: 0 }));
    await cli.suggest('/repo', 'the index command', { type: 'command', limit: 5, local: true, all: true });
    expect(calls[0].args).toEqual([
      ...BASE,
      '--repo',
      '/repo',
      'suggest',
      'the index command',
      '--type',
      'command',
      '--limit',
      '5',
      '--local',
      '--all',
    ]);
  });

  test('index: --working-tree and --full', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.index('/repo', { workingTree: true });
    await cli.index('/repo', { full: true });
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'index', '--working-tree']);
    expect(calls[1].args).toEqual([...BASE, '--repo', '/repo', 'index', '--full']);
  });

  test('add with --link', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.add('/repo', 'acme-org', { link: '/abs/path' });
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'add', 'acme-org', '--link', '/abs/path']);
  });

  test('pull with name, --registry and --dry-run', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.pull('/repo', 'acme-org', { registry: 'acme', dryRun: true });
    expect(calls[0].args).toEqual([
      ...BASE,
      '--repo',
      '/repo',
      'pull',
      'acme-org',
      '--registry',
      'acme',
      '--dry-run',
    ]);
  });

  test('pull --locked (feat/dep-updates: "Reproduce lockfile", no package name)', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.pull('/repo', undefined, { locked: true });
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'pull', '--locked']);
  });

  test('pin (feat/dep-updates): <name>@<version> as one SPEC argument', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.pin('/repo', 'acme-org', '1.0.0');
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'pin', 'acme-org@1.0.0']);
  });

  test('unpin (feat/dep-updates)', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.unpin('/repo', 'acme-org');
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'unpin', 'acme-org']);
  });

  test('clean: bare, --dry-run, and with a [PACKAGE] positional (feat/dep-updates)', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.clean('/repo');
    await cli.clean('/repo', { dryRun: true });
    await cli.clean('/repo', { package: 'acme-org', dryRun: true });
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'clean']);
    expect(calls[1].args).toEqual([...BASE, '--repo', '/repo', 'clean', '--dry-run']);
    expect(calls[2].args).toEqual([...BASE, '--repo', '/repo', 'clean', 'acme-org', '--dry-run']);
  });

  test('--frozen (feat/dep-updates): added before --repo when settings.frozen is true', async () => {
    const calls: RecordedCall[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '', code: 0 };
    };
    const cli = new VaireCli(() => ({ binaryPath: '/fake/vaire', frozen: true }), exec);
    await cli.deps('/repo');
    expect(calls[0].args).toEqual(['-o', 'json', '--no-color', '-q', '--frozen', '--repo', '/repo', 'deps']);
  });

  test('--frozen is omitted when settings.frozen is false/unset (existing behavior unchanged)', async () => {
    const { cli, calls } = fakeCli(() => ok({ name: 'x', version: '1.0.0', dependencies: [] }));
    await cli.deps('/repo');
    expect(calls[0].args).toEqual([...BASE, '--repo', '/repo', 'deps']);
  });

  test('catalogScan', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.catalogScan('/some/dir');
    expect(calls[0].args).toEqual([...BASE, 'catalog', 'scan', '/some/dir']);
  });

  test('init: the path is a positional argument, not --repo', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.init('/abs/new-package');
    expect(calls[0].args).toEqual([...BASE, 'init', '/abs/new-package']);
  });

  test('registryAdd (no --repo — catalog/registry commands are machine-wide)', async () => {
    const { cli, calls } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await cli.registryAdd('acme', 'https://kg.acme.devtest.example.com');
    expect(calls[0].args).toEqual([...BASE, 'registry', 'add', 'acme', 'https://kg.acme.devtest.example.com']);
  });
});

describe('VaireCli error handling', () => {
  test('parses the error envelope from stdout on non-zero exit', async () => {
    const { cli } = fakeCli(() => ({
      stdout: JSON.stringify({ error: { code: 5, kind: 'id_not_found', message: "no node with id 'concept:nope'" } }),
      stderr: '',
      code: 5,
    }));
    try {
      await cli.resolve('/repo', 'concept:nope');
      throw new Error('expected cli.resolve to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaireError);
      expect((err as VaireError).code).toBe(5);
      expect((err as VaireError).kind).toBe('id_not_found');
      expect((err as VaireError).message).toContain('concept:nope');
    }
  });

  test('falls back to stderr envelope when stdout is not JSON', async () => {
    const { cli } = fakeCli(() => ({
      stdout: 'not json',
      stderr: JSON.stringify({ error: { code: 1, kind: 'registry', message: 'registry unreachable' } }),
      code: 1,
    }));
    try {
      await cli.registryShow('acme');
      throw new Error('expected cli.registryShow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaireError);
      expect((err as VaireError).kind).toBe('registry');
    }
  });

  test('non-JSON stdout and stderr on failure -> spawn error with stderr tail', async () => {
    const { cli } = fakeCli(() => ({ stdout: 'not json', stderr: 'boom\nsecond line', code: 1 }));
    try {
      await cli.status('/repo');
      throw new Error('expected cli.status to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaireError);
      expect((err as VaireError).kind).toBe('spawn');
      expect((err as VaireError).message).toContain('boom');
    }
  });

  test('tolerates empty/non-JSON stdout on success (non-JSON-producing commands)', async () => {
    const { cli } = fakeCli(() => ({ stdout: '', stderr: '', code: 0 }));
    await expect(cli.index('/repo', { workingTree: true })).resolves.toEqual({});

    const { cli: cli2 } = fakeCli(() => ({ stdout: 'Indexed 160 nodes.\n', stderr: '', code: 0 }));
    await expect(cli2.add('/repo', 'acme-org')).resolves.toEqual({});
  });
});

describe('VaireCli concurrency', () => {
  test('dedupes identical in-flight read calls', async () => {
    let callCount = 0;
    const { cli } = fakeCli(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return ok({ id: 'concept:reference', type: 'concept', path: 'x.md', frontmatter: {}, superseded_by: null });
    });
    const [a, b] = await Promise.all([
      cli.resolve('/repo', 'concept:reference'),
      cli.resolve('/repo', 'concept:reference'),
    ]);
    expect(callCount).toBe(1);
    expect(a).toEqual(b);
  });

  test('does not dedupe mutating calls', async () => {
    let callCount = 0;
    const { cli } = fakeCli(async () => {
      callCount++;
      return { stdout: '', stderr: '', code: 0 };
    });
    await Promise.all([cli.index('/repo', { workingTree: true }), cli.index('/repo', { workingTree: true })]);
    expect(callCount).toBe(2);
  });

  test('limits concurrency to 4 in flight', async () => {
    let active = 0;
    let maxActive = 0;
    const { cli } = fakeCli(async (args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return ok({ id: args[args.length - 1], type: 'concept', path: 'x.md', frontmatter: {}, superseded_by: null });
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => cli.resolve('/repo', `concept:n${i}`)));
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

describe('VaireCli outcome exit codes', () => {
  test('check exiting 6 with violations still returns the CheckResult', async () => {
    const body = { ok: false, violations: [{ kind: 'missing_dependency', package: 'x', note: 'n' }], warnings: [] };
    const { cli } = fakeCli(() => ({ stdout: JSON.stringify(body), stderr: '', code: 6 }));
    const result = await cli.check('/repo');
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  test('a clap usage error (exit 2, plain stderr) becomes a VaireError with the stderr text', async () => {
    const { cli } = fakeCli(() => ({ stdout: '', stderr: "error: unexpected argument '--limit' found", code: 2 }));
    await expect(cli.unresolved('/repo')).rejects.toMatchObject({ code: 2, message: expect.stringContaining('unexpected argument') });
  });
});
