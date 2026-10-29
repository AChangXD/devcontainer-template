import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'bin', 'create-container.js');

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'create-container-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(cwd, args, environment = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: '1', CREATE_CONTAINER_RUNTIME: 'docker', ...environment },
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function successful(result) {
  assert.equal(result.status, 0, result.output);
}

function rejected(result) {
  assert.notEqual(result.status, 0, result.output);
  assert.ok(result.output.trim(), 'A rejected command should explain what went wrong');
}

function readProject(cwd, name) {
  const directory = join(cwd, name);
  return {
    directory,
    config: JSON.parse(readFileSync(join(directory, '.devcontainer.json'), 'utf8')),
    dockerfile: readFileSync(join(directory, 'Dockerfile'), 'utf8'),
  };
}

test('help and version work without a name and do not create files', (t) => {
  const cwd = workspace(t);
  const help = run(cwd, ['--help']);
  successful(help);
  assert.match(help.output, /create-container/);
  assert.match(help.output, /--packages/);
  assert.match(help.output, /--yes/);

  const version = run(cwd, ['--version']);
  successful(version);
  const expectedVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
  assert.equal(version.stdout.trim(), expectedVersion);
  assert.deepEqual(readdirSync(cwd), []);
});

test('--yes generates the named root configuration and all default components', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['my-project', '--yes']));
  const { directory, config, dockerfile } = readProject(cwd, 'my-project');

  assert.equal(config.name, 'my-project');
  assert.deepEqual(config.build, { dockerfile: 'Dockerfile', context: '.' });
  assert.equal(config.remoteUser, 'vscode');
  assert.equal(config.workspaceFolder, '/workspace');
  assert.equal(existsSync(join(directory, '.devcontainer')), false);
  assert.match(dockerfile, /python3-venv/);
  assert.match(dockerfile, /nvm install/);
  assert.match(dockerfile, /postgresql-18/);
  assert.match(dockerfile, /https:\/\/claude\.ai\/install\.sh/);
  assert.match(dockerfile, /@openai\/codex/);
  assert.ok(existsSync(join(directory, '.dockerignore')));
  assert.ok(existsSync(join(directory, '.gitignore')));
});

test('-y accepts ordinary project name punctuation and retains the exact name', (t) => {
  const cwd = workspace(t);
  const name = 'Example_2.0-dev';
  successful(run(cwd, [name, '-y']));
  assert.equal(readProject(cwd, name).config.name, name);
});

test('--packages none creates a base container without optional configuration', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['minimal', '--packages', 'none']));
  const { directory, dockerfile } = readProject(cwd, 'minimal');

  assert.match(dockerfile, /^FROM\s+/m);
  assert.doesNotMatch(dockerfile, /python3-venv|nvm install|postgresql-18|claude\.ai\/install\.sh|@openai\/codex/);
  assert.equal(existsSync(join(directory, '.codex')), false);
  assert.equal(existsSync(join(directory, 'AGENTS.md')), false);
  assert.equal(existsSync(join(directory, 'scripts', 'postgres.sh')), false);
});

test('an explicit package selection is noninteractive and excludes other components', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['backend', '--packages=python,postgres']));
  const { directory, dockerfile } = readProject(cwd, 'backend');

  assert.match(dockerfile, /python3-venv/);
  assert.match(dockerfile, /postgresql-18/);
  assert.doesNotMatch(dockerfile, /nvm install|claude\.ai\/install\.sh|@openai\/codex/);
  assert.equal(existsSync(join(directory, '.codex')), false);
  assert.ok(statSync(join(directory, 'scripts', 'postgres.sh')).mode & 0o111, 'Postgres helper must be executable');
});

test('Codex alone includes its Node runtime and portable project guidance', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['assistant', '--packages', 'codex']));
  const { directory, dockerfile } = readProject(cwd, 'assistant');

  assert.match(dockerfile, /@openai\/codex/);
  assert.match(dockerfile, /nvm install/);
  assert.doesNotMatch(dockerfile, /python3-venv|postgresql-18|claude\.ai\/install\.sh/);
  assert.ok(existsSync(join(directory, 'AGENTS.md')));
  assert.ok(existsSync(join(directory, '.codex', 'AGENTS.md')));
  const codexConfig = readFileSync(join(directory, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /on-request/);
  assert.match(codexConfig, /workspace-write/);
  assert.doesNotMatch(codexConfig, /danger-full-access|approval_policy\s*=\s*['"]never['"]|\/workspace|mcp_servers/);
  assert.deepEqual(readdirSync(join(directory, '.codex')).sort(), ['AGENTS.md', 'config.toml']);
  assert.equal(existsSync(join(directory, '.aws')), false);
});

test('Claude Code can be selected without Python, Node, Postgres, or Codex', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['claude-only', '--packages', 'claude']));
  const { directory, dockerfile } = readProject(cwd, 'claude-only');

  assert.match(dockerfile, /https:\/\/claude\.ai\/install\.sh/);
  assert.doesNotMatch(dockerfile, /python3-venv|nvm install|postgresql-18|@openai\/codex/);
  assert.equal(existsSync(join(directory, '.codex')), false);
});

test('existing directories and files are never overwritten, including empty directories', (t) => {
  const cwd = workspace(t);
  mkdirSync(join(cwd, 'empty'));
  mkdirSync(join(cwd, 'existing'));
  writeFileSync(join(cwd, 'existing', 'keep.txt'), 'keep this content');
  writeFileSync(join(cwd, 'file'), 'keep this file');

  for (const name of ['empty', 'existing', 'file']) {
    rejected(run(cwd, [name, '--yes']));
  }

  assert.deepEqual(readdirSync(join(cwd, 'empty')), []);
  assert.deepEqual(readdirSync(join(cwd, 'existing')), ['keep.txt']);
  assert.equal(readFileSync(join(cwd, 'existing', 'keep.txt'), 'utf8'), 'keep this content');
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'keep this file');
  assert.deepEqual(readdirSync(cwd).sort(), ['empty', 'existing', 'file']);
});

test('existing symlinks, including dangling symlinks, are preserved', (t) => {
  const cwd = workspace(t);
  const target = join(cwd, 'target');
  mkdirSync(target);
  symlinkSync(target, join(cwd, 'linked'));
  symlinkSync(join(cwd, 'missing'), join(cwd, 'dangling'));

  rejected(run(cwd, ['linked', '--yes']));
  rejected(run(cwd, ['dangling', '--yes']));

  assert.ok(lstatSync(join(cwd, 'linked')).isSymbolicLink());
  assert.equal(realpathSync(join(cwd, 'linked')), target);
  assert.ok(lstatSync(join(cwd, 'dangling')).isSymbolicLink());
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(readdirSync(cwd).sort(), ['dangling', 'linked', 'target']);
});

test('noninteractive invocation requires a name and explicit package acceptance', (t) => {
  const cwd = workspace(t);
  for (const args of [[], ['--yes'], ['--packages', 'python'], ['project']]) {
    rejected(run(cwd, args));
  }
  assert.match(run(cwd, ['project']).output, /--yes|--packages|interactive|terminal/i);
  assert.deepEqual(readdirSync(cwd), []);
});

test('invalid folder names are rejected before any files are written', (t) => {
  const cwd = workspace(t);
  const invalidNames = ['', '.', '..', '../escape', 'nested/project', 'nested\\project', 'with space', 'line\nbreak', 'trailing\n', 'trailing\r', 'tab\tname', 'control\x01name', '.hidden', '-hidden', '_hidden', 'x'.repeat(129)];
  for (const name of invalidNames) {
    rejected(run(cwd, [name, '--yes']));
    assert.deepEqual(readdirSync(cwd), [], `Invalid name ${JSON.stringify(name)} left files behind`);
  }
});

test('unknown arguments and invalid package lists fail before creating a project', (t) => {
  const cwd = workspace(t);
  const invalidArgs = [
    ['project', '--unknown'],
    ['project', 'extra'],
    ['project', '--packages'],
    ['project', '--packages', 'ruby'],
    ['project', '--packages', 'python,unknown'],
    ['project', '--packages', 'none,python'],
    ['project', '--packages', ''],
    ['project', '--packages='],
  ];
  for (const args of invalidArgs) {
    rejected(run(cwd, args));
    assert.deepEqual(readdirSync(cwd), [], `Invalid args ${JSON.stringify(args)} left files behind`);
  }
});

test('Apple runtime gives terminal build/run and editor attachment instructions', (t) => {
  const cwd = workspace(t);
  const result = run(cwd, ['my-project', '--packages', 'none'], { CREATE_CONTAINER_RUNTIME: 'apple' });
  successful(result);
  assert.match(result.output, /container build/);
  assert.match(result.output, /container run/);
  assert.match(result.output, /experimental|Attach to Running Apple Container/i);
  assert.doesNotMatch(result.output, /In VS Code, run "Dev Containers: Reopen in Container"/);
  assert.equal(readProject(cwd, 'my-project').config.name, 'my-project');
});
