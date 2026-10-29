import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = join(repository, 'bin', 'create-container');
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

  const mounts = optionValues(args, ['--volume', '-v', '--mount']);
  assert.equal(mounts.length, 5, 'Only the four generator inputs and destination should be mounted');
  for (const source of ['bin', 'lib', 'templates', 'package.json']) {
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

test('installer creates both command links and can be run again without npm', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'user bin with spaces');
  const docker = mockDocker(directory);

  successful(run(installer, ['--bin-dir', binDirectory], directory, docker.environment));
  successful(run(installer, ['--bin-dir', binDirectory], directory, docker.environment));
  for (const name of ['create-container', 'create-dev-container']) {
    const command = join(binDirectory, name);
    assert.ok(lstatSync(command).isSymbolicLink());
    assert.equal(realpathSync(command), launcher);
    successful(run(command, ['my-project', '--yes'], directory, docker.environment));
    assert.deepEqual(docker.args().slice(-2), ['my-project', '--yes']);
  }
});

test('launcher resolves a relative symlink installed in a path with spaces', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'relative links');
  mkdirSync(binDirectory);
  const command = join(binDirectory, 'create-container');
  symlinkSync(relative(binDirectory, launcher), command);
  const docker = mockDocker(directory);

  successful(run(command, ['project', '--packages', 'none'], directory, docker.environment));
  const mounts = optionValues(docker.args(), ['--volume', '-v', '--mount']);
  assert.ok(mounts.some((value) => value.includes(join(repository, 'templates'))));
});

test('installer refuses unrelated existing commands before installing either alias', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory);
  const collision = join(binDirectory, 'create-dev-container');
  writeFileSync(collision, 'keep the existing command');

  const result = run(installer, ['--bin-dir', binDirectory], directory);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(readFileSync(collision, 'utf8'), 'keep the existing command');
  assert.equal(existsSync(join(binDirectory, 'create-container')), false);
  assert.deepEqual(readdirSync(binDirectory), ['create-dev-container']);
});

test('installer preserves unrelated dangling symlinks', (t) => {
  const directory = workspace(t);
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory);
  const collision = join(binDirectory, 'create-container');
  symlinkSync(join(directory, 'missing'), collision);

  const result = run(installer, ['--bin-dir', binDirectory], directory);
  assert.notEqual(result.status, 0, result.output);
  assert.ok(lstatSync(collision).isSymbolicLink());
  assert.equal(existsSync(join(binDirectory, 'create-dev-container')), false);
});

test('installer help and invalid arguments do not create an installation', (t) => {
  const directory = workspace(t);
  successful(run(installer, ['--help'], directory));
  for (const args of [['--unknown'], ['--bin-dir'], ['--bin-dir', '']]) {
    const result = run(installer, args, directory);
    assert.notEqual(result.status, 0, result.output);
  }
  assert.deepEqual(readdirSync(directory), []);
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
  assert.equal(volumes.length, 5);
  for (const source of ['bin', 'lib', 'templates', 'package.json']) {
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
