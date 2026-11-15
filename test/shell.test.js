import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = join(repository, 'bin', 'create-container');
const initLauncher = join(repository, 'bin', 'init-container');
const installer = join(repository, 'scripts', 'install.sh');

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'create-container-shell-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(script, args, cwd, environment = {}) {
  const result = spawnSync('/bin/bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CREATE_CONTAINER_RUNTIME: 'auto', ...environment },
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function successful(result) {
  assert.equal(result.status, 0, result.output);
}

function mockDocker(directory) {
  const binDirectory = join(directory, 'mock bin');
  const argsFile = join(directory, 'docker-arguments');
  mkdirSync(binDirectory);
  writeFileSync(join(binDirectory, 'docker'), `#!/bin/bash
if [[ "\${1:-}" = run ]]; then
  printf '%s\\0' "$@" > "$DOCKER_TEST_ARGS"
  exit "\${DOCKER_TEST_STATUS:-0}"
fi
exit 0
`, { mode: 0o755 });

  // Any accidental use of a host language runtime makes the launcher fail.
  for (const name of ['node', 'npm', 'npx', 'python', 'python3']) {
    writeFileSync(join(binDirectory, name), '#!/bin/bash\nprintf "Host runtime invoked\\n" >&2\nexit 97\n', { mode: 0o755 });
  }
  return {
    environment: { PATH: `${binDirectory}:${process.env.PATH}`, DOCKER_TEST_ARGS: argsFile },
    args: () => readFileSync(argsFile, 'utf8').split('\0').slice(0, -1),
  };
}

function optionValues(args, names) {
  return args.flatMap((arg, index) => names.includes(arg) ? [args[index + 1]] : []);
}

test('shell launcher runs the generator in Docker without invoking host runtimes', (t) => {
  const directory = workspace(t);
  const cwd = join(directory, 'project parent with spaces');
  mkdirSync(cwd);
  const docker = mockDocker(directory);
  const input = ['my-project', '--packages', 'python,postgres'];
  successful(run(launcher, input, cwd, docker.environment));

  const args = docker.args();
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('-i') || args.includes('--interactive'));
  assert.equal(args.includes('-t') || args.includes('--tty'), false, 'Piped invocation must not request a TTY');
  assert.deepEqual(optionValues(args, ['--network']), ['none']);
  assert.deepEqual(optionValues(args, ['--cap-drop']), ['ALL']);
  assert.ok(optionValues(args, ['--security-opt']).includes('no-new-privileges'));
  assert.match(optionValues(args, ['--user', '-u'])[0], /^\d+:\d+$/);
  assert.deepEqual(optionValues(args, ['--workdir', '-w']), ['/workspace']);
  assert.equal(optionValues(args, ['--env', '-e']).some((value) => value.startsWith('CREATE_CONTAINER_PROJECT_NAME=')), false);

  const mounts = optionValues(args, ['--volume', '-v', '--mount']);
  assert.equal(mounts.length, 6, 'Only the five generator inputs and destination should be mounted');
  for (const source of ['bin', 'lib', 'templates', 'package.json', '.codex/config.toml']) {
    const mount = mounts.find((value) => value.includes(`/opt/create-container/${source}`));
    assert.ok(mount, `Missing ${source} input mount`);
    assert.ok(mount.includes(join(repository, source)));
    assert.match(mount, /:ro$|readonly|read-only/);
  }
  const destinationMount = mounts.find((value) => value.includes(cwd));
  assert.ok(destinationMount?.includes('/workspace'));
  assert.doesNotMatch(destinationMount, /:ro$|readonly|read-only/);
  assert.equal(args.some((arg) => arg.includes('docker.sock')), false);
  assert.equal(args.includes('--privileged'), false);

  const imageIndex = args.indexOf('docker.io/library/node:22-bookworm-slim');
  assert.ok(imageIndex > 0);
  assert.deepEqual(args.slice(imageIndex + 1), ['node', '/opt/create-container/bin/create-container.js', ...input]);
  assert.deepEqual(readdirSync(cwd), [], 'A mock Docker launch must not create host project files');
});

test('shell launcher preserves arguments literally and propagates the Docker exit status', (t) => {
  const directory = workspace(t);
  const docker = mockDocker(directory);
  const sentinel = join(directory, 'unexpected');
  const input = [`name with spaces; touch ${sentinel}`, '--packages=none'];
  const result = run(launcher, input, directory, { ...docker.environment, DOCKER_TEST_STATUS: '42' });
  assert.equal(result.status, 42, result.output);
  assert.deepEqual(docker.args().slice(-input.length), input);
  assert.equal(existsSync(sentinel), false);
});

test('installer creates all three command links and can be run again without npm', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'user bin with spaces');
  const docker = mockDocker(directory);

  successful(run(installer, ['--no-path-update', '--bin-dir', binDirectory], directory, docker.environment));
  successful(run(installer, ['--no-path-update', '--bin-dir', binDirectory], directory, docker.environment));
  for (const name of ['create-container', 'create-dev-container', 'init-container']) {
    const command = join(binDirectory, name);
    assert.ok(lstatSync(command).isSymbolicLink());
    assert.equal(realpathSync(command), launcher);
    const args = name === 'init-container' ? ['--yes'] : ['my-project', '--yes'];
    const entrypoint = name === 'init-container' ? 'init-container.js' : 'create-container.js';
    successful(run(command, args, directory, docker.environment));
    const runtimeArgs = docker.args();
    const imageIndex = runtimeArgs.indexOf('docker.io/library/node:22-bookworm-slim');
    assert.deepEqual(runtimeArgs.slice(imageIndex + 1), ['node', `/opt/create-container/bin/${entrypoint}`, ...args]);
  }
});

test('launcher resolves a relative symlink installed in a path with spaces', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'relative links');
  mkdirSync(binDirectory);
  const docker = mockDocker(directory);

  for (const [name, source, args] of [
    ['create-container', launcher, ['project', '--packages', 'none']],
    ['init-container', initLauncher, ['--packages', 'none']],
  ]) {
    const command = join(binDirectory, name);
    symlinkSync(relative(binDirectory, source), command);
    successful(run(command, args, directory, docker.environment));
    const runtimeArgs = docker.args();
    const mounts = optionValues(runtimeArgs, ['--volume', '-v', '--mount']);
    assert.ok(mounts.some((value) => value.includes(join(repository, 'templates'))));
    assert.ok(runtimeArgs.includes(`/opt/create-container/bin/${name}.js`));
  }
});

for (const name of ['create-container', 'create-dev-container', 'init-container']) {
  test(`installer refuses an existing ${name} before installing any command`, (t) => {
    const directory = workspace(t);
    const binDirectory = join(directory, 'bin');
    const config = join(directory, 'shellrc');
    mkdirSync(binDirectory);
    const collision = join(binDirectory, name);
    writeFileSync(collision, 'keep the existing command');

    const result = run(installer, ['--bin-dir', binDirectory, '--shell-config', config], directory);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(readFileSync(collision, 'utf8'), 'keep the existing command');
    assert.deepEqual(readdirSync(binDirectory), [name]);
    assert.equal(existsSync(config), false, 'Collision preflight must precede PATH configuration');
  });
}

test('installer preserves unrelated dangling symlinks', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory);
  const collision = join(binDirectory, 'create-container');
  symlinkSync(join(directory, 'missing'), collision);

  const result = run(installer, ['--no-path-update', '--bin-dir', binDirectory], directory);
  assert.notEqual(result.status, 0, result.output);
  assert.ok(lstatSync(collision).isSymbolicLink());
  assert.equal(existsSync(join(binDirectory, 'create-dev-container')), false);
  assert.equal(existsSync(join(binDirectory, 'init-container')), false);
});

test('installer help and invalid arguments do not create an installation', (t) => {
  const directory = workspace(t);
  successful(run(installer, ['--help'], directory));
  for (const args of [['--unknown'], ['--bin-dir'], ['--bin-dir', ''], ['--shell-config'], ['--shell-config', '']]) {
    const result = run(installer, args, directory);
    assert.notEqual(result.status, 0, result.output);
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('installer persists PATH once and a fresh shell can find all three commands', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'user bin');
  const config = join(directory, 'shell configuration');
  const original = '# Keep existing shell preferences\nexport PROJECT_PREFERENCE=keep';
  writeFileSync(config, original);

  successful(run(installer, ['--bin-dir', binDirectory, '--shell-config', config], directory));
  const installed = readFileSync(config, 'utf8');
  assert.ok(installed.startsWith(original), 'Existing shell configuration must be preserved');
  assert.notEqual(installed, original);
  successful(run(installer, ['--bin-dir', binDirectory, '--shell-config', config], directory, {
    PATH: `${binDirectory}:${process.env.PATH}`,
  }));
  assert.equal(readFileSync(config, 'utf8'), installed, 'Reinstalling must not duplicate the PATH setup');

  const freshShell = run('-c', [
    'source "$1"; source "$1"; command -v create-container; command -v create-dev-container; command -v init-container; printf "%s\\n" "$PROJECT_PREFERENCE" "$PATH"',
    'check-path', config,
  ], directory, { PATH: '/usr/bin:/bin' });
  successful(freshShell);
  const [command, alias, init, preference, path] = freshShell.stdout.trimEnd().split('\n');
  assert.equal(command, join(binDirectory, 'create-container'));
  assert.equal(alias, join(binDirectory, 'create-dev-container'));
  assert.equal(init, join(binDirectory, 'init-container'));
  assert.equal(preference, 'keep');
  assert.equal(path.split(':').filter((entry) => entry === binDirectory).length, 1);
});

test('installer quotes shell syntax in the installation path literally', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin $(touch RC_PATH_EXECUTED) `touch RC_BACKTICK_EXECUTED` "quotes" \'single\'');
  const config = join(directory, 'shellrc');
  successful(run(installer, ['--bin-dir', binDirectory, '--shell-config', config], directory));

  const freshShell = run('-c', ['source "$1"; command -v create-container', 'check-path', config], directory, { PATH: '/usr/bin:/bin' });
  successful(freshShell);
  assert.equal(freshShell.stdout.trimEnd(), join(binDirectory, 'create-container'));
  assert.equal(existsSync(join(directory, 'RC_PATH_EXECUTED')), false);
  assert.equal(existsSync(join(directory, 'RC_BACKTICK_EXECUTED')), false);
});

test('installer honors ZDOTDIR and makes commands available in a fresh zsh session', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin');
  const configDirectory = join(directory, 'zsh config');
  mkdirSync(configDirectory);
  successful(run(installer, ['--bin-dir', binDirectory], directory, { ZDOTDIR: configDirectory }));

  const config = join(configDirectory, '.zshrc');
  assert.ok(existsSync(config));
  const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync);
  let freshShell;
  if (zsh) {
    const result = spawnSync(zsh, ['-d', '-i', '-c', 'command -v create-container'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ZDOTDIR: configDirectory, PATH: '/usr/bin:/bin' },
    });
    assert.ifError(result.error);
    freshShell = { ...result, output: result.stdout + result.stderr };
  } else {
    t.diagnostic('zsh is unavailable; checking the generated startup syntax with Bash');
    freshShell = run('-c', ['source "$1"; command -v create-container', 'check-path', config], directory, { PATH: '/usr/bin:/bin' });
  }
  successful(freshShell);
  assert.equal(freshShell.stdout.trimEnd(), join(binDirectory, 'create-container'));
});

test('--no-path-update installs links while leaving shell configuration untouched', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin');
  const config = join(directory, 'shellrc');
  writeFileSync(config, '# existing config\n');
  successful(run(installer, ['--bin-dir', binDirectory, '--shell-config', config, '--no-path-update'], directory));
  assert.equal(readFileSync(config, 'utf8'), '# existing config\n');
  assert.ok(lstatSync(join(binDirectory, 'create-container')).isSymbolicLink());
  const absentConfig = join(directory, 'absent-shellrc');
  successful(run(installer, ['--bin-dir', binDirectory, '--shell-config', absentConfig, '--no-path-update'], directory));
  assert.equal(existsSync(absentConfig), false);
});

test('launcher explains when Docker is unavailable', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'limited-bin');
  mkdirSync(binDirectory);
  for (const command of ['bash', 'dirname', 'readlink', 'id', 'pwd']) {
    const source = ['/bin', '/usr/bin'].map((base) => join(base, command)).find(existsSync);
    if (source) symlinkSync(source, join(binDirectory, command));
  }
  const result = run(launcher, ['project', '--yes'], directory, { PATH: binDirectory });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Docker|docker/);
  assert.equal(existsSync(join(directory, 'project')), false);
});

function mockRuntimes(directory, engines) {
  const binDirectory = join(directory, 'runtime bin');
  const argsFile = join(directory, 'runtime-arguments');
  const engineFile = join(directory, 'runtime-engine');
  mkdirSync(binDirectory);
  for (const command of ['bash', 'dirname', 'readlink', 'id', 'pwd']) {
    const source = ['/bin', '/usr/bin'].map((base) => join(base, command)).find(existsSync);
    if (source) symlinkSync(source, join(binDirectory, command));
  }
  for (const engine of engines) {
    writeFileSync(join(binDirectory, engine), `#!/bin/bash
printf '%s' '${engine}' > "$RUNTIME_TEST_ENGINE"
printf '%s\\0' "$@" > "$RUNTIME_TEST_ARGS"
exit "\${RUNTIME_TEST_STATUS:-0}"
`, { mode: 0o755 });
  }
  for (const command of ['node', 'npm', 'npx', 'python', 'python3']) {
    writeFileSync(join(binDirectory, command), '#!/bin/bash\nprintf "Host runtime invoked\\n" >&2\nexit 97\n', { mode: 0o755 });
  }
  return {
    environment: { PATH: binDirectory, RUNTIME_TEST_ARGS: argsFile, RUNTIME_TEST_ENGINE: engineFile },
    invoked: () => existsSync(engineFile),
    engine: () => readFileSync(engineFile, 'utf8'),
    args: () => readFileSync(argsFile, 'utf8').split('\0').slice(0, -1),
  };
}

for (const [runtime, engine] of [['docker', 'docker'], ['apple', 'container']]) {
  test(`init-container uses the current folder and preserves its host name with ${runtime}`, (t) => {
    const directory = workspace(t);
    const projectName = 'Existing project, "quoted" $(touch UNEXPECTED)';
    const cwd = join(directory, projectName);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'existing.txt'), 'keep existing project files');
    const runtimes = mockRuntimes(directory, ['docker', 'container']);
    const input = ['--packages', 'python,node'];
    successful(run(initLauncher, [...input, '--runtime', runtime], cwd, runtimes.environment));

    assert.equal(runtimes.engine(), engine);
    const args = runtimes.args();
    assert.deepEqual(optionValues(args, ['--workdir', '-w']), ['/workspace']);
    assert.deepEqual(optionValues(args, ['--env', '-e']), [
      `CREATE_CONTAINER_RUNTIME=${runtime}`,
      `CREATE_CONTAINER_PROJECT_NAME=${projectName}`,
    ]);
    const volumes = optionValues(args, ['--mount', '--volume', '-v']);
    const writableVolumes = volumes.filter((value) => !/:ro$|readonly|read-only/.test(value));
    assert.deepEqual(writableVolumes, [runtime === 'apple'
      ? `${cwd}:/workspace`
      : `type=bind,"source=${cwd.replaceAll('"', '""')}",target=/workspace`]);
    const imageIndex = args.indexOf('docker.io/library/node:22-bookworm-slim');
    assert.deepEqual(args.slice(imageIndex + 1), ['node', '/opt/create-container/bin/init-container.js', ...input]);
    assert.deepEqual(readdirSync(cwd), ['existing.txt']);
    assert.equal(readFileSync(join(cwd, 'existing.txt'), 'utf8'), 'keep existing project files');

    // Interactive init has no project argument and no generator flags.
    successful(run(initLauncher, [`--runtime=${runtime}`], cwd, runtimes.environment));
    assert.deepEqual(runtimes.args().slice(-2), ['node', '/opt/create-container/bin/init-container.js']);
    assert.equal(existsSync(join(cwd, 'UNEXPECTED')), false);
  });
}

test('explicit Apple runtime uses supported flags and preserves mounted paths and arguments', (t) => {
  const directory = workspace(t);
  const cwd = join(directory, 'project parent, with "quotes"');
  mkdirSync(cwd);
  const runtimes = mockRuntimes(directory, ['docker', 'container']);
  const input = ['my-project', '--packages', 'python,postgres'];
  successful(run(launcher, ['--runtime', 'apple', ...input], cwd, runtimes.environment));

  assert.equal(runtimes.engine(), 'container');
  const args = runtimes.args();
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('-i') || args.includes('--interactive'));
  assert.equal(args.includes('-t') || args.includes('--tty'), false);
  assert.deepEqual(optionValues(args, ['--network']), ['none']);
  assert.deepEqual(optionValues(args, ['--cap-drop']), ['ALL']);
  assert.match(optionValues(args, ['--user', '-u'])[0], /^\d+:\d+$/);
  assert.deepEqual(optionValues(args, ['--workdir', '-w']), ['/workspace']);
  assert.ok(optionValues(args, ['--env', '-e']).includes('CREATE_CONTAINER_RUNTIME=apple'));
  assert.equal(args.includes('--security-opt'), false);
  assert.equal(args.includes('--mount'), false, 'Apple mount parser does not support Docker CSV syntax');
  assert.equal(args.includes('--runtime'), false, 'Launcher runtime option must not reach Apple CLI or generator');

  const volumes = optionValues(args, ['--volume', '-v']);
  assert.equal(volumes.length, 6);
  for (const source of ['bin', 'lib', 'templates', 'package.json', '.codex/config.toml']) {
    assert.ok(volumes.includes(`${join(repository, source)}:/opt/create-container/${source}:ro`));
  }
  assert.ok(volumes.includes(`${cwd}:/workspace`) || volumes.includes(`${cwd}:/workspace:rw`));
  const imageIndex = args.indexOf('docker.io/library/node:22-bookworm-slim');
  assert.ok(imageIndex > 0);
  assert.deepEqual(args.slice(imageIndex + 1), ['node', '/opt/create-container/bin/create-container.js', ...input]);
  assert.deepEqual(readdirSync(cwd), []);
});

test('automatic runtime selection prefers Docker and uses Apple when Docker is absent', (t) => {
  const directory = workspace(t);
  for (const engines of [['docker', 'container'], ['container']]) {
    const cwd = join(directory, engines.join('-'));
    mkdirSync(cwd);
    const runtimes = mockRuntimes(cwd, engines);
    successful(run(launcher, ['project', '--yes'], cwd, runtimes.environment));
    assert.equal(runtimes.engine(), engines[0]);
  }
});

test('runtime flags override environment selection and work after the project name', (t) => {
  const directory = workspace(t);
  const runtimes = mockRuntimes(directory, ['docker', 'container']);
  successful(run(launcher, ['project', '--yes'], directory, {
    ...runtimes.environment, CREATE_CONTAINER_RUNTIME: 'apple',
  }));
  assert.equal(runtimes.engine(), 'container');
  successful(run(launcher, ['project', '--runtime=docker', '--yes'], directory, {
    ...runtimes.environment, CREATE_CONTAINER_RUNTIME: 'apple',
  }));
  assert.equal(runtimes.engine(), 'docker');
  assert.deepEqual(runtimes.args().slice(-2), ['project', '--yes']);
});

test('an unavailable or failing explicit runtime never falls back to another engine', (t) => {
  const directory = workspace(t);
  const runtimes = mockRuntimes(directory, ['docker']);
  const missing = run(launcher, ['--runtime', 'apple', 'project', '--yes'], directory, runtimes.environment);
  assert.notEqual(missing.status, 0, missing.output);
  assert.match(missing.output, /Apple|container/);
  assert.equal(runtimes.invoked(), false);

  const failing = run(launcher, ['--runtime', 'docker', 'project', '--yes'], directory, {
    ...runtimes.environment, RUNTIME_TEST_STATUS: '42',
  });
  assert.equal(failing.status, 42, failing.output);
  assert.equal(runtimes.engine(), 'docker');
});

test('invalid runtime selections are rejected before invoking an engine', (t) => {
  const directory = workspace(t);
  const runtimes = mockRuntimes(directory, ['docker', 'container']);
  for (const args of [['--runtime'], ['--runtime='], ['--runtime', 'podman'], ['project', '--runtime', '--yes']]) {
    const result = run(launcher, args, directory, runtimes.environment);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(runtimes.invoked(), false);
  }
  const invalidEnvironment = run(launcher, ['project', '--yes'], directory, {
    ...runtimes.environment, CREATE_CONTAINER_RUNTIME: 'podman',
  });
  assert.notEqual(invalidEnvironment.status, 0, invalidEnvironment.output);
  assert.equal(runtimes.invoked(), false);
});

test('Apple runtime rejects colon-containing mount paths before invocation', (t) => {
  const directory = workspace(t);
  const cwd = join(directory, 'parent:folder');
  mkdirSync(cwd);
  const runtimes = mockRuntimes(directory, ['container']);
  const result = run(launcher, ['--runtime=apple', 'project', '--yes'], cwd, runtimes.environment);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /colon|:/);
  assert.equal(runtimes.invoked(), false);
  assert.deepEqual(readdirSync(cwd), []);
});
