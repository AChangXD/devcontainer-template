# Claude Code's native installer supports x64 and ARM64 without Node.js.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version
