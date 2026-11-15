#!/bin/bash
set -euo pipefail

usage() {
    printf 'Usage: bash scripts/install.sh [--bin-dir PATH] [--shell-config PATH] [--no-path-update]\n'
    printf 'Install create-container, create-dev-container, and init-container (Docker or Apple container launcher).\n'
    printf 'Default directory: ~/.local/bin. No Node, npm, Python, or sudo needed.\n'
    printf 'Adds the command directory to PATH in ${ZDOTDIR:-$HOME}/.zshrc.\n'
    printf 'Use --shell-config for another shell startup file, or --no-path-update to skip it.\n'
}

install_dir="$HOME/.local/bin"
shell_config="${ZDOTDIR:-$HOME}/.zshrc"
update_path=true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bin-dir)
            if [[ $# -lt 2 || -z "$2" ]]; then
                printf '%s\n' '--bin-dir requires a directory path.' >&2
                exit 1
            fi
            install_dir="$2"
            shift 2
            ;;
        --shell-config)
            if [[ $# -lt 2 || -z "$2" ]]; then
                printf '%s\n' '--shell-config requires a file path.' >&2
                exit 1
            fi
            shell_config="$2"
            shift 2
            ;;
        --no-path-update)
            update_path=false
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

repository_dir="$(cd -P -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
launcher="$repository_dir/bin/create-container"
if [[ ! -x "$launcher" ]]; then
    printf 'Missing executable launcher: %s\n' "$launcher" >&2
    exit 1
fi

case "$install_dir" in
    /*) ;;
    *) install_dir="$PWD/$install_dir" ;;
esac
mkdir -p "$install_dir"
install_dir="$(cd -P -- "$install_dir" && pwd)"

# Check all names before writing any links. Existing unrelated commands stay.
for command_name in create-container create-dev-container init-container; do
    destination="$install_dir/$command_name"
    if [[ -e "$destination" || -L "$destination" ]]; then
        if [[ -L "$destination" && "$(readlink "$destination")" == "$launcher" ]]; then
            continue
        fi
        printf 'Refusing to replace existing path: %s\nChoose another --bin-dir or remove that path yourself.\n' "$destination" >&2
        exit 1
    fi
done

if [[ "$update_path" == true ]]; then
    case "$install_dir" in
        *:*)
            printf 'Cannot add a directory containing a colon to PATH: %s\n' "$install_dir" >&2
            exit 1
            ;;
    esac
    case "$shell_config" in
        /*) ;;
        *) shell_config="$PWD/$shell_config" ;;
    esac
    if [[ -e "$shell_config" && ! -f "$shell_config" ]]; then
        printf 'Shell configuration is not a regular file: %s\n' "$shell_config" >&2
        exit 1
    fi
    # Quote paths as shell literals; never interpret their contents as code.
    printf -v quoted_install_dir '%q' "$install_dir"
    path_line="case \":\$PATH:\" in *:${quoted_install_dir}:*) ;; *) export PATH=${quoted_install_dir}:\"\$PATH\" ;; esac"
    # Check the file even if this terminal already has the directory in PATH:
    # a temporary export does not configure future shells.
    if [[ -f "$shell_config" ]] && grep -Fqx "$path_line" "$shell_config"; then
        printf 'PATH is already configured in %s\n' "$shell_config"
    else
        mkdir -p "$(dirname "$shell_config")"
        printf '\n# create-container command path\n%s\n' "$path_line" >> "$shell_config"
        printf 'Added persistent PATH configuration to %s\n' "$shell_config"
    fi
fi

for command_name in create-container create-dev-container init-container; do
    destination="$install_dir/$command_name"
    if [[ ! -L "$destination" ]]; then
        ln -s "$launcher" "$destination"
    fi
done

printf 'Installed create-container, create-dev-container, and init-container in %s\n' "$install_dir"
printf 'Keep this repository at %s; the commands link to it.\n' "$repository_dir"
if [[ "$update_path" == true ]]; then
    printf '\nOpen a new terminal, or apply this once in your current terminal:\n'
    printf '  source %q\n' "$shell_config"
else
    printf '\nShell configuration unchanged. To use this terminal:\n'
    printf '  export PATH=%q:"$PATH"\n' "$install_dir"
fi
printf '\nStart Docker Desktop or run container system start, then run: create-container my-app\n'
printf 'Select Apple explicitly with: create-container --runtime apple my-app\n'
printf 'Set up an existing project: cd /path/to/project && init-container\n'
