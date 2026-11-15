import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'bin', 'init-container.js');

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'init-container-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(cwd, args, environment = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CREATE_CONTAINER_RUNTIME: 'docker',
      CREATE_CONTAINER_PROJECT_NAME: '',
      ...environment,
    },
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

// Record metadata and contents without following symlinks, so rejected commands
// and repeat initialization must leave every existing entry untouched.
function snapshot(directory) {
  return readdirSync(directory).sort().map((name) => {
    const filename = join(directory, name);
    const metadata = lstatSync(filename);
    const entry = { name, mode: metadata.mode, mtime: metadata.mtimeMs };
    if (metadata.isSymbolicLink()) entry.link = readlinkSync(filename);
    else if (metadata.isDirectory()) entry.children = snapshot(filename);
    else entry.contents = readFileSync(filename).toString('base64');
    return entry;
  });
}

test('init help and version work without changing the current folder', (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'existing.txt'), 'keep this file');
  const before = snapshot(cwd);
  const help = run(cwd, ['--help']);
  successful(help);
  assert.match(help.output, /init-container/);
  assert.match(help.output, /--packages/);
  assert.match(help.output, /--yes/);

  const version = run(cwd, ['--version']);
  successful(version);
  const expectedVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
  assert.equal(version.stdout.trim(), expectedVersion);
  assert.deepEqual(snapshot(cwd), before);
});

test('init --yes scaffolds the current existing folder, including names with spaces', (t) => {
  const cwd = join(workspace(t), 'Existing project (v2)');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'source.js'), 'export const existing = true;\n');
  successful(run(cwd, ['--yes']));

  const config = JSON.parse(readFileSync(join(cwd, '.devcontainer', 'devcontainer.json'), 'utf8'));
  const dockerfile = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
  assert.equal(config.name, basename(cwd));
  assert.equal(resolve(cwd, '.devcontainer', config.build.dockerfile), join(cwd, 'Dockerfile'));
  assert.equal(resolve(cwd, '.devcontainer', config.build.context), cwd);
  assert.equal(config.workspaceFolder, '/workspace');
  assert.deepEqual(config.runArgs, ['--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp-bwrap.json']);
  assert.equal(existsSync(join(cwd, basename(cwd))), false, 'Initialization must not create a nested project');
  assert.equal(readFileSync(join(cwd, 'source.js'), 'utf8'), 'export const existing = true;\n');
  for (const pattern of [/python3-venv/, /nvm install/, /postgresql-18/, /claude\.ai\/install\.sh/, /@openai\/codex/]) {
    assert.match(dockerfile, pattern);
  }
  for (const filename of ['.dockerignore', '.gitignore', 'AGENTS.md', '.codex/AGENTS.md']) {
    assert.ok(statSync(join(cwd, filename)).isFile(), filename);
  }
  for (const filename of ['seccomp-bwrap.json', 'seccomp-bwrap.LICENSE']) {
    assert.deepEqual(readFileSync(join(cwd, '.devcontainer', filename)), readFileSync(join(repository, 'templates', 'devcontainer', filename)));
  }
  assert.deepEqual(readFileSync(join(cwd, '.codex', 'config.toml')), readFileSync(join(repository, '.codex', 'config.toml')));
  assert.ok(statSync(join(cwd, 'scripts', 'postgres.sh')).mode & 0o111);
  assert.ok(statSync(join(cwd, 'tmp')).isDirectory());
});

test('init honors the host project name supplied by a container launcher', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['--packages', 'none'], { CREATE_CONTAINER_PROJECT_NAME: 'Host project' }));
  const config = JSON.parse(readFileSync(join(cwd, '.devcontainer', 'devcontainer.json'), 'utf8'));
  assert.equal(config.name, 'Host project');
  assert.equal(existsSync(join(cwd, 'Host project')), false);
});

test('init --packages none creates only the base container', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['--packages', 'none']));
  const dockerfile = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM\s+/m);
  assert.doesNotMatch(dockerfile, /python3-venv|nvm install|postgresql-18|claude\.ai\/install\.sh|@openai\/codex/);
  assert.equal(existsSync(join(cwd, '.codex')), false);
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);
  assert.equal(existsSync(join(cwd, 'scripts', 'postgres.sh')), false);
});

test('init explicit packages are noninteractive and include required runtimes', (t) => {
  const cwd = workspace(t);
  successful(run(cwd, ['--packages=codex,postgres']));
  const dockerfile = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /@openai\/codex/);
  assert.match(dockerfile, /nvm install/);
  assert.match(dockerfile, /postgresql-18/);
  assert.doesNotMatch(dockerfile, /python3-venv|claude\.ai\/install\.sh/);
  assert.ok(statSync(join(cwd, 'scripts', 'postgres.sh')).mode & 0o111);
  assert.ok(statSync(join(cwd, '.codex', 'config.toml')).isFile());
});

test('init preserves existing generated files and fills existing regular directories', (t) => {
  const cwd = workspace(t);
  const existing = {
    Dockerfile: 'FROM custom:image\n',
    '.gitignore': 'my-existing-output/\n',
    '.dockerignore': 'private-input/\n',
    '.codex/config.toml': 'model = "existing-model"\n',
    '.codex/AGENTS.md': 'Existing Codex guidance\n',
    'AGENTS.md': 'Existing project guidance\n',
    '.devcontainer/devcontainer.json': '{"name":"Existing configuration"}\n',
    'scripts/postgres.sh': '#!/bin/sh\necho existing\n',
    'tmp/keep.txt': 'existing scratch file\n',
  };
  for (const [filename, contents] of Object.entries(existing)) {
    mkdirSync(dirname(join(cwd, filename)), { recursive: true });
    writeFileSync(join(cwd, filename), contents, { mode: 0o600 });
  }
  const before = new Map(Object.keys(existing).map((filename) => [filename, lstatSync(join(cwd, filename))]));
  const result = run(cwd, ['--yes']);
  successful(result);
  assert.match(result.output, /skip/i);
  for (const [filename, contents] of Object.entries(existing)) {
    assert.equal(readFileSync(join(cwd, filename), 'utf8'), contents, filename);
    assert.equal(lstatSync(join(cwd, filename)).mode, before.get(filename).mode, filename);
    assert.equal(lstatSync(join(cwd, filename)).mtimeMs, before.get(filename).mtimeMs, filename);
    if (!filename.startsWith('tmp/')) assert.ok(result.output.includes(filename), `Skipped file ${filename} must be reported`);
  }
  assert.ok(statSync(join(cwd, '.devcontainer', 'seccomp-bwrap.json')).isFile());
});

test('repeating init leaves generated and user files untouched', (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'keep.txt'), 'keep this content');
  successful(run(cwd, ['-y']));
  const before = snapshot(cwd);
  const repeated = run(cwd, ['-y']);
  successful(repeated);
  assert.match(repeated.output, /skip/i);
  assert.deepEqual(snapshot(cwd), before);
});

test('init preserves existing file symlinks, including dangling symlinks', (t) => {
  const root = workspace(t);
  const cwd = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(cwd);
  mkdirSync(outside);
  mkdirSync(join(cwd, '.codex'));
  writeFileSync(join(outside, 'Dockerfile'), 'FROM existing:image\n');
  writeFileSync(join(outside, 'config.toml'), 'model = "keep-me"\n');
  const links = {
    Dockerfile: join(outside, 'Dockerfile'),
    '.codex/config.toml': join(outside, 'config.toml'),
    '.gitignore': join(outside, 'missing'),
  };
  for (const [filename, target] of Object.entries(links)) symlinkSync(target, join(cwd, filename));
  const before = snapshot(outside);
  const result = run(cwd, ['--yes']);
  successful(result);
  assert.match(result.output, /skip/i);
  for (const [filename, target] of Object.entries(links)) {
    assert.ok(lstatSync(join(cwd, filename)).isSymbolicLink());
    assert.equal(readlinkSync(join(cwd, filename)), target);
    assert.ok(result.output.includes(filename), `Skipped symlink ${filename} must be reported`);
  }
  assert.deepEqual(snapshot(outside), before);
});

for (const directory of ['.devcontainer', '.codex', 'scripts', 'tmp']) {
  test(`init rejects a symlink at ${directory} before writing any files`, (t) => {
    const root = workspace(t);
    const cwd = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(cwd);
    mkdirSync(outside);
    writeFileSync(join(cwd, 'keep.txt'), 'keep this project');
    writeFileSync(join(outside, 'keep.txt'), 'keep the symlink target');
    symlinkSync(outside, join(cwd, directory));
    const before = snapshot(root);
    const result = run(cwd, ['--yes']);
    rejected(result);
    assert.ok(result.output.includes(directory), result.output);
    assert.deepEqual(snapshot(root), before);
  });

  test(`init rejects a file at required directory ${directory} before writing any files`, (t) => {
    const cwd = workspace(t);
    writeFileSync(join(cwd, 'keep.txt'), 'keep this project');
    writeFileSync(join(cwd, directory), 'keep this conflicting file');
    const before = snapshot(cwd);
    rejected(run(cwd, ['--yes']));
    assert.deepEqual(snapshot(cwd), before);
  });
}

for (const filename of ['Dockerfile', '.devcontainer/devcontainer.json', '.codex/config.toml', 'scripts/postgres.sh']) {
  test(`init rejects a directory at generated file ${filename} before writing any files`, (t) => {
    const cwd = workspace(t);
    mkdirSync(join(cwd, filename), { recursive: true });
    writeFileSync(join(cwd, filename, 'keep.txt'), 'keep this directory and its contents');
    const before = snapshot(cwd);
    rejected(run(cwd, ['--yes']));
    assert.deepEqual(snapshot(cwd), before);
  });
}

test('a write failure rolls back new files while preserving the existing project', (t) => {
  if (process.getuid?.() === 0 || process.platform === 'win32') {
    t.skip('This permission-based failure requires an unprivileged POSIX user');
    return;
  }
  const cwd = workspace(t);
  const codexDirectory = join(cwd, '.codex');
  mkdirSync(codexDirectory);
  writeFileSync(join(cwd, 'keep.txt'), 'keep this project');
  writeFileSync(join(codexDirectory, 'keep.txt'), 'keep this directory');
  chmodSync(codexDirectory, 0o555);
  try {
    const before = snapshot(cwd);
    const result = run(cwd, ['--yes']);
    rejected(result);
    assert.match(result.output, /EACCES|permission/i);
    assert.deepEqual(snapshot(cwd), before);
  } finally {
    chmodSync(codexDirectory, 0o755);
  }
});

test('noninteractive init requires explicit package acceptance', (t) => {
  const cwd = workspace(t);
  const result = run(cwd, []);
  rejected(result);
  assert.match(result.output, /--yes|--packages|interactive|terminal/i);
  assert.deepEqual(readdirSync(cwd), []);
});

test('init rejects a project name or path and directs users to run in the existing folder', (t) => {
  const cwd = workspace(t);
  for (const name of ['new-project', '.', '../other-project', '/tmp/other-project']) {
    const result = run(cwd, [name, '--yes']);
    rejected(result);
    assert.match(result.output, /inside|current|folder|directory/i);
    assert.deepEqual(readdirSync(cwd), []);
  }
});

test('invalid init options and packages fail before changing the existing folder', (t) => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'keep.txt'), 'existing content');
  const before = snapshot(cwd);
  const invalidArgs = [
    ['--unknown'],
    ['--packages'],
    ['--packages', 'ruby'],
    ['--packages', 'python,unknown'],
    ['--packages', 'none,python'],
    ['--packages', ''],
    ['--packages='],
    ['--packages', 'none', '--packages', 'python'],
  ];
  for (const args of invalidArgs) {
    rejected(run(cwd, args));
    assert.deepEqual(snapshot(cwd), before, JSON.stringify(args));
  }
});

test('init Apple runtime instructions build in the current project folder', (t) => {
  const cwd = workspace(t);
  const result = run(cwd, ['--packages', 'none'], { CREATE_CONTAINER_RUNTIME: 'apple' });
  successful(result);
  assert.match(result.output, /container build/);
  assert.match(result.output, /container run/);
  assert.match(result.output, /experimental|Attach to Running Apple Container/i);
  assert.doesNotMatch(result.output, /\bcd\s/);
});
