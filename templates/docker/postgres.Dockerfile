# PostgreSQL 18 from the official PGDG repository, on either amd64 or arm64.
# Installing tools does not create a cluster or start a database.
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' "$VERSION_CODENAME" \
       > /etc/apt/sources.list.d/pgdg.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common \
    && printf '\ncreate_main_cluster = false\n' >> /etc/postgresql-common/createcluster.conf \
    && apt-get install -y --no-install-recommends postgresql-18 postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

# Expose server administration tools as well as psql.
ENV PATH=/usr/lib/postgresql/18/bin:${PATH}

# Optional local database, from the project directory inside the container:
#   ./scripts/postgres.sh start
#   psql -h /tmp/devcontainer-postgres -U vscode -d postgres
#   ./scripts/postgres.sh stop
