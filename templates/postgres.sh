#!/usr/bin/env bash
set -euo pipefail

# Run inside the dev container. Data persists in the project's ignored .postgres
# directory. The socket stays in /tmp because macOS bind mounts may not support
# Unix socket files. No TCP port or host database is used. Stop it before
# removing its data.
# pg_ctl builds a shell command from -D and -l. Keep the project path out of
# those arguments, including when the project is moved beneath shell syntax.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
postgres_dir=.postgres
data_dir="$postgres_dir/data"
socket_dir=/tmp/devcontainer-postgres

usage() {
    printf 'Usage: %s [start|stop|status]\n' "$0"
}

# pg_ctl passes its -o argument through a shell. Quote paths for that shell too.
shell_quote() {
    printf "'%s'" "${1//\'/\'\\\'\'}"
}

case "${1:-start}" in
    start)
        if [[ "$EUID" -eq 0 ]]; then
            printf 'Run this as the dev container user (vscode), not root.\n' >&2
            exit 1
        fi
        mkdir -p "$postgres_dir" "$socket_dir"
        chmod 700 "$postgres_dir" "$socket_dir"
        if [[ ! -f "$data_dir/PG_VERSION" ]]; then
            initdb -D "$data_dir" --username=vscode --auth-local=trust --auth-host=scram-sha-256
        fi
        if ! pg_ctl -D "$data_dir" status >/dev/null 2>&1; then
            pg_ctl -D "$data_dir" -l "$postgres_dir/postgres.log" \
                -o "-c listen_addresses='' -k $(shell_quote "$socket_dir")" -w start
        fi
        printf 'Connect: psql -h %s -U vscode -d postgres\n' "$(shell_quote "$socket_dir")"
        ;;
    stop)
        pg_ctl -D "$data_dir" -m fast -w stop
        ;;
    status)
        pg_ctl -D "$data_dir" status
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
