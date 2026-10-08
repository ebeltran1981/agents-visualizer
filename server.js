#!/usr/bin/env node
// Streams agent sessions from the selected harness (read-only) over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import claude from './harnesses/claude.js';
import omp from './harnesses/omp.js';
import pi from './harnesses/pi.js';
import opencode from './harnesses/opencode.js';

const HARNESSES = Object.fromEntries([claude, omp, pi, opencode].map(h => [h.id, h]));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 4321);
const LOCAL_PRICES = path.join(HERE, 'prices.local.json');
const STATIC = { '/': ['index.html', 'text/html'], '/aggregate.js': ['aggregate.js', 'text/javascript'] };

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
const startHarness = HARNESSES[arg('--harness')] ?? claude;
const startSession = arg('--session') && startHarness.resolve(arg('--session'));

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function stream(req, res, harness, key) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // A rewritten file ends the stream; the page then reconnects from a fresh state.
  const stop = harness.watch(key, batch => {
    if (!batch.length) return;
    batch.sort((x, y) => (x.r?.ts ?? '').localeCompare(y.r?.ts ?? ''));  // interleave agents by time
    res.write(`data: ${JSON.stringify(batch)}\n\n`);
  }, () => res.end());
  req.on('close', stop);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const harness = HARNESSES[url.searchParams.get('harness')] ?? startHarness;
  if (STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type });
    return fs.createReadStream(path.join(HERE, file)).pipe(res);
  }
  if (url.pathname === '/prices.local.json') {
    let table = {};
    try { table = JSON.parse(fs.readFileSync(LOCAL_PRICES, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error(`prices.local.json ignored: ${e.message}`); }
    return json(res, table);
  }
  if (url.pathname === '/api/harnesses') {
    return json(res, { default: startHarness.id, harnesses: Object.values(HARNESSES).map(({ id, label, bin, root }) => ({ id, label, bin, root })) });
  }
  if (url.pathname === '/api/sessions') {
    const sessions = harness.listSessions();
    return json(res, { default: (harness === startHarness && startSession) || sessions[0]?.key, root: harness.root, sessions });
  }
  if (url.pathname === '/events') {
    const key = url.searchParams.get('session');
    if (harness.valid(key)) return stream(req, res, harness, key);
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`agents-visualizer → http://localhost:${PORT}\nharness: ${startHarness.label}${startSession ? `\nsession: ${startSession}` : ''}`));
