import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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
    'ms-azuretools.vscode-docker',
    'stackbreak.comment-divider',
    'PKief.material-icon-theme',
    'eamodio.gitlens',
  ];
  if (selected.has('python')) extensions.push('ms-python.python', 'ms-python.vscode-pylance');
  if (selected.has('node')) extensions.push('esbenp.prettier-vscode', 'bradlc.vscode-tailwindcss');

  return JSON.stringify({
    name,
    build: { dockerfile: 'Dockerfile', context: '.' },
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

/** Write a scaffold into a new directory already created by the caller. */
export async function createScaffold({ targetDirectory, name, packages }) {
  const selected = selectedPackages(packages);
  const files = [
    ['.devcontainer.json', renderDevcontainer({ name, packages })],
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

  for (const [filename, contents, mode = 0o644] of files) {
    const destination = path.join(targetDirectory, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { encoding: 'utf8', mode, flag: 'wx' });
  }

  await mkdir(path.join(targetDirectory, 'tmp'), { recursive: true });

  return files.map(([filename]) => filename);
}
