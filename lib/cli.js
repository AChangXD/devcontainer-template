import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createScaffold, initializeScaffold } from './scaffold.js';
import { CancelledError, promptName, promptPackages } from './prompts.js';

const choices = [
  { id: 'python', label: 'Python (pip + venv)' },
  { id: 'node', label: 'Node.js 22 + npm' },
  { id: 'postgres', label: 'PostgreSQL 18 (server + client)' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex + .codex configuration' },
];
const packageIds = choices.map(({ id }) => id);

function help(initialize) {
  return `${initialize ? `Usage: init-container [options]

Initialize a development container in the current folder.
Creates missing setup files and reports existing files left unchanged.
Run this command from inside the folder you want to set up.` : `Usage: create-container [folder-name] [options]
       create-dev-container [folder-name] [options]

Create a new folder with a Dockerfile and .devcontainer/devcontainer.json.
Existing folders are never overwritten. Use init-container inside an existing folder.`}
Without options, choose tools using arrows, space, and enter.
All tools are selected by default.

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
  ${initialize ? 'init-container' : 'create-container my-project'}
  ${initialize ? 'init-container' : 'create-container my-project'} --yes
  ${initialize ? 'init-container' : 'create-container my-project'} --packages python,postgres
  ${initialize ? 'init-container' : 'create-container my-project'} --packages none

Codex also installs the Node.js runtime it needs. Claude Code uses its
native installer. Tools are installed when you build/reopen the container.
`;
}

function parseArgs(args, initialize) {
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
    else if (initialize) throw new Error('init-container does not take a folder name. Run it from inside the folder you want to set up.');
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

async function main(initialize) {
  const options = parseArgs(process.argv.slice(2), initialize);
  if (options.help) {
    process.stdout.write(help(initialize));
    return;
  }
  if (options.version) {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(metadata.version);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let name = initialize ? (process.env.CREATE_CONTAINER_PROJECT_NAME || path.basename(process.cwd()) || 'project') : options.name;
  if (name === undefined) {
    if (!interactive || options.yes) throw new Error('A project folder name is required. Example: create-container my-project --yes');
    name = await promptName();
  }
  if (!initialize) validateName(name);

  let packages = options.packages;
  if (packages === undefined) {
    if (options.yes) packages = packageIds;
    else if (interactive) packages = await promptPackages(choices);
    else throw new Error('Interactive selection needs a terminal. Pass --yes for all tools, or --packages python,node,postgres,claude,codex (or none).');
  }

  const targetDirectory = initialize ? process.cwd() : path.resolve(process.cwd(), name);
  let files;
  let skipped = [];
  if (initialize) {
    ({ files, skipped } = await initializeScaffold({ targetDirectory, name, packages }));
  } else {
    try {
      await mkdir(targetDirectory);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`"${name}" already exists. Choose a new folder name or run init-container inside it; existing files were not changed.`);
      throw error;
    }
    try {
      files = await createScaffold({ targetDirectory, name, packages });
    } catch (error) {
      // Only this invocation's newly created project can reach this cleanup.
      await rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  console.log(initialize ? `\nInitialized ${name}/ with ${files.length} new files.` : `\nCreated ${name}/ with ${files.length} files.`);
  if (skipped.length) {
    console.log(`Skipped existing files (left unchanged):\n${skipped.map((filename) => `  ${filename}`).join('\n')}`);
    console.log('Review existing setup files for compatibility with the selected tools.');
  }
  console.log(`Selected: ${packages.length ? packages.join(', ') : 'base container only'}`);
  if (packages.includes('codex') && !packages.includes('node')) {
    console.log('Node.js was included as a runtime dependency of Codex.');
  }
  const changeDirectory = initialize ? '' : `  cd ${name}\n`;
  if (process.env.CREATE_CONTAINER_RUNTIME === 'apple') {
    const imageName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}-dev`;
    console.log(`\nNext:\n${changeDirectory}  container build -t ${imageName} .\n  container run --rm -it --volume "$PWD:/workspace" --workdir /workspace ${imageName} bash`);
    console.log('\nFor VS Code, use its experimental "Attach to Running Apple Container" support. See the generator README for setup; Apple does not use the Docker "Reopen in Container" workflow.');
  } else {
    console.log(`\nNext:\n${changeDirectory}  code .\n\nIn VS Code, run "Dev Containers: Reopen in Container" to build and install the selected tools.`);
  }
  if (packages.includes('postgres')) console.log('Inside the container, run bash scripts/postgres.sh start to start PostgreSQL.');
}

export function runCli({ initialize = false } = {}) {
  return main(initialize).catch((error) => {
    console.error(error instanceof CancelledError ? `\n${error.message}` : `Error: ${error.message}`);
    process.exitCode = error instanceof CancelledError ? 130 : 1;
  });
}
