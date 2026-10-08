// Helpers shared by the harness adapters (server side only).
import fs from 'node:fs';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const tilde = p => p?.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;

// One line describing a tool call's input.
export function summarize(x = {}) {
  const s = x.command ?? x.message ?? x.file_path ?? x.notebook_path ?? x.path ?? x.pattern ?? x.description ?? x.url ?? x.query
    ?? x.prompt ?? x.skill ?? Object.values(x).find(v => typeof v === 'string') ?? '';
  return String(s).split('\n')[0].slice(0, 160);
}

// PASS or FAIL, only when it is the message's last line.
export const verdictOf = text => text.trim().split('\n').pop().replace(/[*`_#\s]/g, '').match(/^(PASS|FAIL)$/)?.[1];

// Returns a poll() that reads only the bytes appended since the last call. A file that shrinks calls onShrink
// instead of being replayed, so nothing is counted twice.
export function tail(file, onLine, onShrink) {
  let pos = 0, rest = '';
  const dec = new StringDecoder('utf8');
  return () => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < pos) return onShrink();
    if (size === pos) return;
    const buf = Buffer.alloc(size - pos), fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    const lines = (rest + dec.write(buf)).split('\n');
    rest = lines.pop();
    lines.forEach(onLine);
  };
}
