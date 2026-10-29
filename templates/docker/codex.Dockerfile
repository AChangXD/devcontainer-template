# Codex uses the Node.js runtime installed above; authenticate after opening.
RUN npm install --global @openai/codex \
    && codex --version
