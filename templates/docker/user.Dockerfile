USER vscode
WORKDIR /home/vscode

ENV PATH=/home/vscode/.local/bin:${PATH}
RUN mkdir -p /home/vscode/.local/bin
