import { createInterface, emitKeypressEvents, moveCursor, cursorTo, clearScreenDown } from 'node:readline';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled. No project created.');
    this.name = 'CancelledError';
  }
}

export function promptName() {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (!answered) reject(new CancelledError());
    });
    rl.question('Project folder name: ', (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptPackages(choices) {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    const selected = new Set(choices.map(({ id }) => id));
    const previousRawMode = Boolean(input.isRaw);
    let cursor = 0;
    let lines = 0;

    function render() {
      if (lines) {
        moveCursor(output, 0, -lines);
        cursorTo(output, 0);
        clearScreenDown(output);
      }
      const rows = [
        'Choose tools (arrows: move, space: toggle, a: all/none, enter: create)',
        ...choices.map(({ id, label }, index) =>
          `${index === cursor ? '>' : ' '} [${selected.has(id) ? 'x' : ' '}] ${label}`),
        'Codex includes a Node.js runtime even if Node.js is unchecked.',
      ];
      const width = Math.max(1, (output.columns || 80) - 1);
      output.write(rows.map((row) => row.slice(0, width)).join('\n') + '\n');
      lines = rows.length;
    }

    function finish(error) {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\x1b[?25h');
      if (error) reject(error);
      else resolve(choices.filter(({ id }) => selected.has(id)).map(({ id }) => id));
    }

    const onEnd = () => finish(new CancelledError());
    const onInterrupt = () => finish(new CancelledError());
    function onKey(text, key = {}) {
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') {
        finish(new CancelledError());
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor + choices.length - 1) % choices.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % choices.length;
        render();
      } else if (key.name === 'space' || text === ' ') {
        const { id } = choices[cursor];
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        render();
      } else if (key.name === 'a') {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach(({ id }) => selected.add(id));
        render();
      }
    }

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write('\x1b[?25l');
    input.on('keypress', onKey);
    input.once('end', onEnd);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    render();
  });
}
