FROM mcr.microsoft.com/devcontainers/base:ubuntu

ENV DEBIAN_FRONTEND=noninteractive

# Use PostgreSQL's official repository to match the existing version-18 data.
# Keep cluster creation separate so installation cannot claim port 5432.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' "$VERSION_CODENAME" \
       > /etc/apt/sources.list.d/pgdg.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common \
    && printf '\ncreate_main_cluster = false\n' >> /etc/postgresql-common/createcluster.conf \
    && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    postgresql-18 \
    postgresql-client-18 \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Expose initdb and pg_ctl as well as the PostgreSQL client tools.
ENV PATH=/usr/lib/postgresql/18/bin:${PATH}

USER vscode
WORKDIR /home/vscode

ENV NVM_DIR=/home/vscode/.nvm
RUN mkdir -p "$NVM_DIR" \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && bash -lc "source $NVM_DIR/nvm.sh && nvm install 22 && nvm alias default 22"

ENV PATH=/home/vscode/.local/bin:/home/vscode/.nvm/versions/node/v22.*/bin:${PATH}

RUN bash -lc "source $NVM_DIR/nvm.sh \
    && nvm use 22 \
    && npm config set prefix /home/vscode/.local \
    && npm i -g @openai/codex"

WORKDIR /workspaces
