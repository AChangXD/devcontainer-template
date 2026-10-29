# Node.js 22 and npm. The stable symlink works in non-interactive shells too.
ENV NVM_DIR=/home/vscode/.nvm
RUN mkdir -p "$NVM_DIR" \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && source "$NVM_DIR/nvm.sh" \
    && nvm install 22 \
    && nvm alias default 22 \
    && ln -s "$(dirname "$(dirname "$(nvm which 22)")")" "$NVM_DIR/current"

ENV PATH=/home/vscode/.nvm/current/bin:${PATH}
