#!/usr/bin/env node

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createScaffold } from '../lib/scaffold.js';
import { CancelledError, promptName, promptPackages } from '../lib/prompts.js';

const choices = [
  { id: 'python', label: 'Python (pip + venv)' },
  { id: 'node', label: 'Node.js 22 + npm' },
  { id: 'postgres', label: 'PostgreSQL 18 (server + client)' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex + .codex configuration' },
];
const packageIds = choices.map(({ id }) => id);

const help = `Usage: create-container [folder-name] [options]
       create-dev-container [folder-name] [options]

Create a new folder with a Dockerfile and root .devcontainer.json.
Without options, choose tools using arrows, space, and enter.
All tools are selected by default. Existing folders are never overwritten.

Options:
  -y, --yes             Use all default tools without the package prompt
  --packages <list>     Select comma-separated tools without a package prompt
                       python,node,postgres,claude,codex (or none)
  -h, --help            Show this help
  -v, --version         Show the version

Bash launcher options:
  --runtime <name>      apple, docker, or auto (default; prefers Docker)
                       Also configurable with CREATE_CONTAINER_RUNTIME

Examples:
  create-container my-project
  create-container my-project --yes
  create-container my-project --packages python,postgres
  create-container my-project --packages none

Codex also installs the Node.js runtime it needs. Claude Code uses its
native installer. Tools are installed when you build/reopen the container.
`;

function parseArgs(args) {
  const options = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--packages' || arg.startsWith('--packages=')) {
      if (options.packages) throw new Error('Provide --packages only once.');
      const value = arg === '--packages' ? args[++index] : arg.slice('--packages='.length);
      if (!value || value.startsWith('-')) {
        throw new Error('--packages needs a comma-separated list, or "none".');
      }
      const ids = value.split(',').map((id) => id.trim());
      if (value === 'none') options.packages = [];
      else {
        const unknown = ids.filter((id) => !packageIds.includes(id));
        if (unknown.length) throw new Error(`Unknown package: ${unknown.join(', ')}. Choose ${packageIds.join(', ')} or none.`);
        options.packages = [...new Set(ids)];
      }
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}. Use --help.`);
    else if (options.name !== undefined) throw new Error('Provide exactly one project folder name.');
    else options.name = arg;
  }
  return options;
}

function validateName(name) {
  if (name.length > 128 || !/^[A-Za-z0-9]/.test(name) || /[^A-Za-z0-9._-]/.test(name)) {
    throw new Error('Use a folder name starting with a letter or number, followed by letters, numbers, dots, underscores, or hyphens (up to 128 characters). Run the command from the desired parent folder.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  if (options.version) {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(metadata.version);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let name = options.name;
  if (name === undefined) {
    if (!interactive || options.yes) throw new Error('A project folder name is required. Example: create-container my-project --yes');
    name = await promptName();
  }
  validateName(name);

  let packages = options.packages;
  if (packages === undefined) {
    if (options.yes) packages = packageIds;
    else if (interactive) packages = await promptPackages(choices);
    else throw new Error('Interactive selection needs a terminal. Pass --yes for all tools, or --packages python,node,postgres,claude,codex (or none).');
  }

  const targetDirectory = path.resolve(process.cwd(), name);
  try {
    await mkdir(targetDirectory);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`"${name}" already exists. Choose a new folder name; existing files were not changed.`);
    throw error;
  }

  let files;
  try {
    files = await createScaffold({ targetDirectory, name, packages });
  } catch (error) {
    // Only this invocation's newly created project can reach this cleanup.
    await rm(targetDirectory, { recursive: true, force: true });
    throw error;
  }

  console.log(`\nCreated ${name}/ with ${files.length} files.`);
  console.log(`Selected: ${packages.length ? packages.join(', ') : 'base container only'}`);
  if (packages.includes('codex') && !packages.includes('node')) {
    console.log('Node.js was included as a runtime dependency of Codex.');
  }
  if (process.env.CREATE_CONTAINER_RUNTIME === 'apple') {
    const imageName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}-dev`;
    console.log(`\nNext:\n  cd ${name}\n  container build -t ${imageName} .\n  container run --rm -it --volume "$PWD:/workspace" --workdir /workspace ${imageName} bash`);
    console.log('\nFor VS Code, use its experimental "Attach to Running Apple Container" support. See the generator README for setup; Apple does not use the Docker "Reopen in Container" workflow.');
  } else {
    console.log(`\nNext:\n  cd ${name}\n  code .\n\nIn VS Code, run "Dev Containers: Reopen in Container" to build and install the selected tools.`);
  }
  if (packages.includes('postgres')) console.log('Inside the container, run bash scripts/postgres.sh start to start PostgreSQL.');
}

main().catch((error) => {
  console.error(error instanceof CancelledError ? `\n${error.message}` : `Error: ${error.message}`);
  process.exitCode = error instanceof CancelledError ? 130 : 1;
});
