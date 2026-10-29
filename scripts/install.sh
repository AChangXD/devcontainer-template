#!/bin/bash
set -euo pipefail

usage() {
    printf 'Usage: bash scripts/install.sh [--bin-dir PATH]\n'
    printf 'Install create-container and create-dev-container (Docker or Apple container launcher).\n'
    printf 'Default directory: ~/.local/bin. No Node, npm, Python, or sudo needed.\n'
}

install_dir="$HOME/.local/bin"
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

# Check both names before writing either link. Existing unrelated commands stay.
for command_name in create-container create-dev-container; do
    destination="$install_dir/$command_name"
    if [[ -e "$destination" || -L "$destination" ]]; then
        if [[ -L "$destination" && "$(readlink "$destination")" == "$launcher" ]]; then
            continue
        fi
        printf 'Refusing to replace existing path: %s\nChoose another --bin-dir or remove that path yourself.\n' "$destination" >&2
        exit 1
    fi
done

for command_name in create-container create-dev-container; do
    destination="$install_dir/$command_name"
    if [[ ! -L "$destination" ]]; then
        ln -s "$launcher" "$destination"
    fi
done

printf 'Installed create-container and create-dev-container in %s\n' "$install_dir"
printf 'Keep this repository at %s; the commands link to it.\n' "$repository_dir"
case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        printf '\nAdd this line to ~/.zshrc and run it in your current terminal:\n'
        printf '  export PATH=%q:"$PATH"\n' "$install_dir"
        ;;
esac
printf '\nStart Docker Desktop or run container system start, then run: create-container my-app\n'
printf 'Select Apple explicitly with: create-container --runtime apple my-app\n'
