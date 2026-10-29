import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helper = new URL('../templates/postgres.sh', import.meta.url);

// Exercise the helper without starting a server or touching its shared socket.
// The pg_ctl double intentionally models PostgreSQL's second shell evaluation.
const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PG_HELPER_TRACE, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
const option = (name) => args[args.indexOf(name) + 1];
if (command === 'mkdir' || command === 'chmod') {
  for (const target of args.slice(1)) {
    if (target === '/tmp/devcontainer-postgres') continue;
    if (command === 'mkdir') fs.mkdirSync(target, { recursive: true });
    else fs.chmodSync(target, parseInt(args[0], 8));
  }
} else if (command === 'initdb') {
  fs.mkdirSync(option('-D'), { recursive: true });
  fs.writeFileSync(path.join(option('-D'), 'PG_VERSION'), '18');
} else if (command === 'pg_ctl') {
  const data = option('-D');
  const running = path.join(data, 'running');
  const action = args[args.length - 1];
  if (action === 'status') process.exit(fs.existsSync(running) ? 0 : 3);
  if (action === 'stop') fs.rmSync(running);
  if (action === 'start') {
    // Like pg_ctl, wrap -D and -l in double quotes and invoke /bin/sh.
    const shellCommand = 'test -d "' + data + '" >> "' + option('-l') + '"';
    const result = spawnSync('/bin/sh', ['-c', shellCommand], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    fs.writeFileSync(running, 'running');
  }
}
`;

for (const parentName of ['$(touch HELPER_PATH_EXECUTED)', '`touch HELPER_PATH_EXECUTED`', 'spaces and "double" and \'single\' quotes']) {
  test(`Postgres helper treats project path ${JSON.stringify(parentName)} as data`, {
    skip: process.getuid?.() === 0 ? 'The PostgreSQL helper intentionally refuses to start as root' : false,
  }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'create-container-postgres-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const project = join(directory, parentName, 'project');
    const caller = join(directory, 'unrelated caller');
    const bin = join(directory, 'mock-bin');
    const trace = join(directory, 'trace.jsonl');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    mkdirSync(caller);
    mkdirSync(bin);
    const script = join(project, 'scripts', 'postgres.sh');
    copyFileSync(helper, script);
    const mockPath = join(bin, 'mock.cjs');
    writeFileSync(mockPath, mock, { mode: 0o755 });
    for (const command of ['initdb', 'pg_ctl', 'mkdir', 'chmod']) {
      symlinkSync(mockPath, join(bin, command));
    }

    for (const [action, expectedStatus] of [['start', 0], ['start', 0], ['status', 0], ['stop', 0], ['status', 3]]) {
      const result = spawnSync('/bin/bash', [script, action], {
        cwd: caller,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PG_HELPER_TRACE: trace },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      for (const location of [caller, project, directory]) {
        assert.equal(existsSync(join(location, 'HELPER_PATH_EXECUTED')), false, 'Project path executed a shell command');
      }
      assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    }

    assert.equal(readFileSync(join(project, '.postgres', 'data', 'PG_VERSION'), 'utf8'), '18');
    assert.ok(existsSync(join(project, '.postgres', 'postgres.log')));
    assert.equal(existsSync(join(caller, '.postgres')), false, 'Files belong in the project, not the caller directory');
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.filter(({ command }) => command === 'initdb').length, 1, 'Repeated start must preserve the existing database');
    assert.equal(calls.filter(({ command, args }) => command === 'pg_ctl' && args.at(-1) === 'start').length, 1);
  });
}
