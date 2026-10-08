#!/usr/bin/env node
// Tails Claude Code transcripts (read-only) and streams slimmed records over SSE.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { slim } from './aggregate.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 4321);
const STATIC = { '/': ['index.html', 'text/html'], '/aggregate.js': ['aggregate.js', 'text/javascript'] };

// Folder names turn '/' into '-', which is lossy, so read the real cwd from the transcript head.
function cwdOf(file) {
  const buf = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  const head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  fs.closeSync(fd);
  const cwd = head.match(/"cwd":"([^"]+)"/)?.[1];
  return cwd && cwd.replace(os.homedir(), '~');
}

function listSessions(limit = 40) {
  const out = [];
  for (const project of fs.readdirSync(ROOT)) {
    let files;
    try { files = fs.readdirSync(path.join(ROOT, project)); } catch { continue; }
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      const p = path.join(ROOT, project, f), st = fs.statSync(p);
      if (!st.size) continue;
      out.push({ path: p, project, cwd: cwdOf(p) ?? project, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// --session accepts a transcript path or a session id
function resolveSession(arg) {
  if (!arg) return listSessions(1)[0]?.path;
  if (arg.endsWith('.jsonl')) return path.resolve(arg);
  return listSessions(Infinity).find(s => s.id === arg)?.path;
}

const isTranscript = p => p && path.resolve(p).startsWith(ROOT + path.sep) && p.endsWith('.jsonl') && fs.existsSync(p);

// Returns a poll() that reads only the bytes appended since the last call.
function tail(file, onLine) {
  let pos = 0, rest = '';
  const dec = new StringDecoder('utf8');
  return () => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < pos) pos = 0;
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

function stream(req, res, session) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const subDir = path.join(session.slice(0, -6), 'subagents');
  const polls = new Map();
  let batch = [];
  const follow = (id, file) => polls.set(id, tail(file, line => {
    try { const r = slim(JSON.parse(line)); if (r) batch.push({ a: id, r }); } catch {}
  }));

  follow('main', session);
  const tick = () => {
    let files = [];
    try { files = fs.readdirSync(subDir); } catch {}
    for (const f of files) {
      const id = f.match(/^agent-(.+)\.jsonl$/)?.[1];
      if (!id || polls.has(id)) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${id}.meta.json`), 'utf8')); } catch {}
      batch.push({ a: id, meta });
      follow(id, path.join(subDir, f));
    }
    polls.forEach(poll => poll());
    if (!batch.length) return;
    batch.sort((x, y) => (x.r?.ts ?? '').localeCompare(y.r?.ts ?? ''));  // interleave agents by time
    res.write(`data: ${JSON.stringify(batch)}\n\n`);
    batch = [];
  };
  tick();
  const timer = setInterval(tick, 500);
  req.on('close', () => clearInterval(timer));
}

const argIdx = process.argv.indexOf('--session');
const defaultSession = resolveSession(argIdx > 0 ? process.argv[argIdx + 1] : '');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type });
    return fs.createReadStream(path.join(HERE, file)).pipe(res);
  }
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ default: defaultSession, sessions: listSessions() }));
  }
  if (url.pathname === '/events') {
    const session = url.searchParams.get('session') || defaultSession;
    if (isTranscript(session)) return stream(req, res, session);
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`agents-visualizer → http://localhost:${PORT}\nsession: ${defaultSession}`));
