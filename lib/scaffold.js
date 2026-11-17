import { readFileSync } from 'node:fs';
import { lstat, mkdir, open, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const packageIds = new Set(['python', 'node', 'postgres', 'claude', 'codex']);

function selectedPackages(packages) {
  if (!Array.isArray(packages) || packages.some((id) => !packageIds.has(id))) {
    throw new Error('Packages must be an array of python, node, postgres, claude, or codex.');
  }
  return new Set(packages);
}

function template(filename) {
  return readFileSync(new URL(`../templates/${filename}`, import.meta.url), 'utf8');
}

export function renderDockerfile(packages) {
  const selected = selectedPackages(packages);
  const sections = [template('docker/base.Dockerfile')];

  if (selected.has('python')) sections.push(template('docker/python.Dockerfile'));
  if (selected.has('postgres')) sections.push(template('docker/postgres.Dockerfile'));
  sections.push(template('docker/user.Dockerfile'));

  if (selected.has('node') || selected.has('codex')) {
    if (!selected.has('node')) sections.push('# Node.js is included as the runtime for Codex.');
    sections.push(template('docker/node.Dockerfile'));
  }
  if (selected.has('claude')) sections.push(template('docker/claude.Dockerfile'));
  if (selected.has('codex')) sections.push(template('docker/codex.Dockerfile'));
  sections.push('WORKDIR /workspace\n');

  return sections.map((section) => section.trimEnd()).join('\n\n') + '\n';
}

export function renderDevcontainer({ name, packages }) {
  const selected = selectedPackages(packages);
  const extensions = [
    'ms-vscode.live-server',
    'ms-azuretools.vscode-docker',
    'PKief.material-icon-theme',
    'eamodio.gitlens',
  ];
  if (selected.has('python')) extensions.push('ms-python.python', 'ms-python.vscode-pylance');
  if (selected.has('node')) extensions.push('esbenp.prettier-vscode', 'bradlc.vscode-tailwindcss');

  return JSON.stringify({
    name,
    build: { dockerfile: '../Dockerfile', context: '..' },
    runArgs: ['--security-opt=seccomp=${localWorkspaceFolder}/.devcontainer/seccomp-bwrap.json'],
    remoteUser: 'vscode',
    workspaceFolder: '/workspace',
    workspaceMount: 'source=${localWorkspaceFolder},target=/workspace,type=bind',
    customizations: {
      vscode: {
        settings: {
          'editor.formatOnSave': true,
          'workbench.iconTheme': 'material-icon-theme',
        },
        extensions,
      },
    },
  }, null, 2) + '\n';
}

function scaffoldFiles({ name, packages }) {
  const selected = selectedPackages(packages);
  const files = [
    ['.devcontainer/devcontainer.json', renderDevcontainer({ name, packages })],
    ['.devcontainer/seccomp-bwrap.json', template('devcontainer/seccomp-bwrap.json')],
    ['.devcontainer/seccomp-bwrap.LICENSE', template('devcontainer/seccomp-bwrap.LICENSE')],
    ['Dockerfile', renderDockerfile(packages)],
    ['.dockerignore', template('dockerignore')],
    ['.gitignore', template('gitignore')],
  ];

  if (selected.has('postgres')) {
    files.push(['scripts/postgres.sh', template('postgres.sh'), 0o755]);
  }
  if (selected.has('codex')) {
    files.push(
      ['.codex/config.toml', readFileSync(new URL('../.codex/config.toml', import.meta.url), 'utf8')],
      ['.codex/AGENTS.md', template('codex/AGENTS.md')],
      ['AGENTS.md', template('AGENTS.md')],
    );
  }
  return files;
}

/** Write a scaffold into a new directory already created by the caller. */
export async function createScaffold({ targetDirectory, name, packages }) {
  const files = scaffoldFiles({ name, packages });
  for (const [filename, contents, mode = 0o644] of files) {
    const destination = path.join(targetDirectory, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { encoding: 'utf8', mode, flag: 'wx' });
  }

  await mkdir(path.join(targetDirectory, 'tmp'), { recursive: true });

  return files.map(([filename]) => filename);
}

async function existingPath(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Add missing scaffold files without changing existing project files. */
export async function initializeScaffold({ targetDirectory, name, packages }) {
  const files = scaffoldFiles({ name, packages });
  const directories = [...new Set([
    ...files.map(([filename]) => path.dirname(filename)).filter((directory) => directory !== '.'),
    'tmp',
  ])];

  // Check the full layout before writing. In particular, never follow a
  // project's directory symlinks into another location when adding files.
  for (const directory of directories) {
    const info = await existingPath(path.join(targetDirectory, directory));
    if (info && !info.isDirectory()) {
      throw new Error(`Cannot initialize: ${directory} must be a directory, not a symlink or another file type. No files were changed.`);
    }
  }

  const pending = [];
  const skipped = [];
  for (const file of files) {
    const [filename] = file;
    const info = await existingPath(path.join(targetDirectory, filename));
    if (info) {
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new Error(`Cannot initialize: ${filename} already exists and is not a file. No files were changed.`);
      }
      skipped.push(filename);
    } else {
      pending.push(file);
    }
  }

  const createdDirectories = [];
  const createdFiles = [];
  try {
    for (const directory of directories) {
      const destination = path.join(targetDirectory, directory);
      try {
        await mkdir(destination);
        createdDirectories.push(destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await lstat(destination)).isDirectory()) {
          throw new Error(`Cannot initialize: ${directory} must be a directory, not a symlink or another file type.`);
        }
      }
    }
    for (const [filename, contents, mode = 0o644] of pending) {
      const destination = path.join(targetDirectory, filename);
      const file = await open(destination, 'wx', mode);
      createdFiles.push(filename);
      try {
        await file.writeFile(contents, 'utf8');
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    // Roll back only paths this call created. Never recursively remove an
    // existing project or a directory that now contains someone else's files.
    const cleanupErrors = [];
    for (const filename of createdFiles.reverse()) {
      try {
        await unlink(path.join(targetDirectory, filename));
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') cleanupErrors.push(filename);
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError.code)) cleanupErrors.push(directory);
      }
    }
    if (cleanupErrors.length) error.message += ` Could not clean up: ${cleanupErrors.join(', ')}.`;
    throw error;
  }

  return { files: createdFiles, skipped };
}
