# create-container

Create a named project folder with a ready-to-build VS Code development container. Choose Python, Node.js, PostgreSQL, Claude Code, and Codex in the terminal; all five are selected by default.

The generator runs inside a disposable container using Docker or Apple's `container` CLI. Your Mac only runs a small Bash launcher: no local Node.js, npm, or Python installation is needed. Build the generated Dockerfile with your chosen runtime to install the tools you selected.

## Install once on macOS

Install and start either [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Apple `container`](#using-apple-container). The launcher uses the Bash shell already included with macOS. For editing inside a container, use [VS Code with the Dev Containers extension](https://code.visualstudio.com/docs/devcontainers/containers); the Apple workflow currently uses its experimental attach support, described below.

Keep this repository in a permanent location. If you already have a local copy, run the installer there. Otherwise, clone it with Git first:

```bash
mkdir -p ~/tools
git clone https://github.com/AChangXD/docker-python-scripting.git ~/tools/create-container
cd ~/tools/create-container
bash scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer links `create-container` and its alias `create-dev-container` into `~/.local/bin`. Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` once to make them available in new terminals. It does not need `sudo` or modify your shell configuration. Keep the repository in place because the commands point to its launcher.

Create a project from wherever you keep your work:

```bash
mkdir -p ~/projects
cd ~/projects
create-container my-app
```

Use the arrow keys to move, Space to select or deselect packages, `a` to toggle all, and Enter to confirm. Run `create-container` without a name to enter it at a prompt. The name becomes both the new directory name and the dev container's display name.

The selected runtime downloads the Node 22 image on the first run and reuses its cached copy afterward. The launcher runs the generator in that container and removes the container when it exits. Its source files are mounted read-only, while your current directory is mounted for writing the new project. With Docker, use a local context: [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) cannot mount your Mac's folders into a remote Docker daemon.

With Docker, open the generated folder in VS Code and run **Dev Containers: Reopen in Container** from the Command Palette. To use `code my-app` from Terminal, first install VS Code's `code` command on your PATH.

## Commands and package choices

```bash
create-container my-app                         # Interactive package selection
create-dev-container my-app                     # Same command, alternate name
create-container my-app --yes                   # All five default packages
create-container my-app --packages python,node  # Explicit selection, no checklist
create-container my-app --packages none         # Base development container
create-container --runtime apple my-app         # Use Apple's container CLI
create-container --runtime docker my-app        # Use Docker
create-container --help
create-container --version
```

The Bash launcher accepts `--runtime auto|docker|apple`. Its default, `auto`, uses Docker when that command is installed, otherwise Apple's `container`. Set `export CREATE_CONTAINER_RUNTIME=apple` in your shell to prefer Apple; a `--runtime` flag overrides that environment variable. These options select the runtime for generating files, while the generated Dockerfile remains usable with either runtime.

Use `--packages` with a comma-separated list of these IDs:

| ID | Container tools |
| --- | --- |
| `python` | Python 3, pip, and virtual environment support |
| `node` | Node.js 22 and npm |
| `postgres` | PostgreSQL 18 server, client tools, and a local database helper |
| `claude` | Claude Code, installed using its native installer |
| `codex` | Codex CLI and this repository's `.codex/config.toml` |

Codex also installs Node.js inside the development container as its runtime dependency when `node` is not selected. Claude Code uses its native installer independently of the Node.js selection. Neither choice installs a runtime on your Mac. Sign in to the AI tools from inside the container after it builds.

The destination must be a new folder; the generator refuses to overwrite an existing path. Run from the desired parent directory and use a name starting with a letter or number, followed by letters, numbers, dots, underscores, or hyphens. For scripts and other noninteractive use, supply a name and either `--yes` or `--packages`.

## Using Apple container

Apple's `container` CLI is a separate installation built on macOS virtualization. Its supported host is an **Apple silicon Mac running macOS 26**. Download the signed `.pkg` from [Apple's releases](https://github.com/apple/container/releases), install it, and start the service. This launcher targets version **1.6.1 or newer**; the integration was checked against the [1.6.1 documentation](https://github.com/apple/container/blob/1.6.1/README.md).

```bash
container system start
# Run the repository's bash scripts/install.sh once, as shown above.
create-container --runtime apple my-app
```

The Apple launcher uses volume mounts and rejects repository or working-directory paths containing `:` because that character separates mount fields. Spaces in paths are supported.

Build and enter the generated environment from your Mac:

```bash
cd my-app
container build -t my-app-dev .
container run --rm -it --name my-app-dev \
  -v "$PWD:/workspace" -w /workspace my-app-dev bash
```

The generated image already selects the `vscode` user. Source files and local PostgreSQL data remain in your mounted project folder. Apple's [command reference](https://github.com/apple/container/blob/1.6.1/docs/command-reference.md) documents Dockerfile builds and interactive execution. A real Apple container build/run still needs verification on a compatible Mac.

For VS Code, start a detached container instead of the interactive command above:

```bash
container run -d --name my-app-dev \
  -v "$PWD:/workspace" -w /workspace my-app-dev sleep infinity
```

Enable this VS Code user setting:

```json
"dev.containers.experimentalAppleContainerSupport": true
```

Then run **Dev Containers: Attach to Running Apple Container...**, select `my-app-dev`, and open `/workspace`. Microsoft introduced this as [experimental attach support](https://github.com/microsoft/vscode-remote-release/issues/11012). It does not provide the normal Docker **Reopen in Container** workflow: do not expect `.devcontainer.json` lifecycle commands, extensions, or settings to be applied automatically. Keep those files for the Docker workflow and configure extensions manually when attaching with Apple.

When finished, run `container stop my-app-dev` and `container rm my-app-dev` on your Mac.

## Generated project

With all default options selected:

```text
my-app/
├── .devcontainer.json
├── Dockerfile
├── .dockerignore
├── .gitignore
├── AGENTS.md
├── .codex/
│   ├── AGENTS.md
│   └── config.toml
├── tmp/
└── scripts/
    └── postgres.sh
```

The configuration lives at the project root as `.devcontainer.json`, a [location supported by VS Code](https://code.visualstudio.com/docs/devcontainers/create-dev-container). Its `name` is `my-app`, and it builds the adjacent `Dockerfile`. There is no generated `.devcontainer` directory.

The Dockerfile contains the selected installation steps. Codex configuration and instruction files are generated only when Codex is selected; authentication files are never copied. The PostgreSQL helper is included only when PostgreSQL is selected. Commit these generated files with your new project so its environment is version controlled.

Every generated project includes an empty `tmp/` scratch directory, excluded from Git and the Docker build context, even when no packages are selected.

The generator copies this repository's `.codex/config.toml` exactly, including its model, reasoning, approval, agent, feature, plugin, and terminal settings. Edit that file to change the default for future projects. Linked installations read it on each run, so editing it or pulling repository updates takes effect without reinstalling. Published npm packages include the configuration from that release. Existing generated projects keep their own copy.

PostgreSQL is installed without automatically starting a database. From the generated project's root **inside the container**, initialize and start it with:

```bash
./scripts/postgres.sh start
./scripts/postgres.sh status
psql -h /tmp/devcontainer-postgres -U vscode -d postgres
./scripts/postgres.sh stop
```

The first start creates the database under `.postgres/data`. The helper keeps its log in `.postgres/`, which is excluded from Git and the Docker build context. Data stays with the project across container rebuilds. Its Unix socket lives at `/tmp/devcontainer-postgres` inside the container so it does not depend on macOS shared-folder socket support. TCP connections are disabled.

## Keep the command updated

For personal use, keep the linked clone as the installation. Pulling repository updates updates the command used for future projects:

```bash
git -C ~/tools/create-container pull --ff-only
create-container --version
```

Existing generated projects keep their own files and are not changed by generator updates. If you move the clone, remove the old command links and run `bash scripts/install.sh` again from its new location. To refresh the generator's cached Node image, run `docker pull node:22-bookworm-slim` or `container image pull docker.io/library/node:22-bookworm-slim` for your selected runtime.

To remove the installed command links:

```bash
rm "$HOME/.local/bin/create-container" "$HOME/.local/bin/create-dev-container"
```

## Optional local Node.js installation

If you prefer to run the generator directly and already have Node.js 22+ with npm, run `npm link` from this repository instead of the Bash installer. [`npm link`](https://docs.npmjs.com/cli/v11/commands/npm-link/) exposes the same two command names and runs the JavaScript CLI locally. Use one installation method at a time so your PATH selects the intended command.

## Optional npm distribution

The Bash launcher does not require npm publishing. Publishing remains an option for people who use Node.js locally: **npx** runs a package from **npm**, which is the package registry. The package name is currently `@achangxd/create-container`. Confirm that you own the `@achangxd` npm user or organization, or change the scope in `package.json` and these examples before publishing.

Once your package is published, users can run either:

```bash
npx @achangxd/create-container@latest my-app
npm create @achangxd/container@latest my-app
```

[`npm create`](https://docs.npmjs.com/cli/npm-init/) maps `@achangxd/container` to the `@achangxd/create-container` package. Use `--` to forward flags through npm:

```bash
npm create @achangxd/container@latest my-app -- --packages python,node
```

Before the first release:

1. Confirm the package name, repository URL, license, and version in `package.json`.
2. Run `npm test` and inspect `npm pack --dry-run` to review the files that will ship.
3. Build a generated container on your Mac and check the tools you selected.
4. Sign in to your npm account with `npm login`, enable two-factor authentication, and publish with `npm publish --access public` when you are ready. See npm's [scoped public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

For later releases, increment the package version before publishing. Consumers can use an explicit version instead of `@latest` when they want a fixed generator release.
