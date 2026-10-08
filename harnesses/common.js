// Helpers shared by the harness adapters (server side only).
import fs from 'node:fs';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const tilde = p => p?.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;

// One line describing a tool call's input.
export function summarize(x = {}) {
  const s = x.command ?? x.message ?? x.file_path ?? x.notebook_path ?? x.path ?? x.pattern ?? x.description ?? x.url ?? x.query
    ?? x.prompt ?? x.skill ?? x.summary ?? Object.values(x).find(v => typeof v === 'string') ?? '';
  return String(s).split('\n')[0].slice(0, 160);
}

// PASS or FAIL, only when it is the message's last line.
export const verdictOf = text => text.trim().split('\n').pop().replace(/[*`_#\s]/g, '').match(/^(PASS|FAIL)$/)?.[1];

// Runs tick now and every ms. An error (say, a format the adapter doesn't know) stops this stream, not the server.
export function every(ms, tick, end) {
  const run = () => { try { tick(); } catch (e) { clearInterval(timer); console.error(`stream ended: ${e.message}`); end(); } };
  const timer = setInterval(run, ms);
  run();
  return () => clearInterval(timer);
}

// Returns a poll() that reads only the bytes appended since the last call. A file that shrinks or is replaced
// (oh-my-pi rewrites via rename) calls onShrink instead of being replayed, so nothing is counted twice.
export function tail(file, onLine, onShrink) {
  let pos = 0, rest = '', ino;
  const dec = new StringDecoder('utf8');
  return () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < pos || (ino && st.ino !== ino)) return onShrink();
    ino = st.ino;
    const size = st.size;
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
