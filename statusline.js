#!/usr/bin/env node
// Claude Code status line: stdin JSON → "opus ● plan · sonnet ✎ editing │ $0.12 vs $4.96"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slim, createState, ingest, ingestMeta, summary, stateOf, verb, family, setLocalPrices } from './aggregate.js';

// Optional company rates and names, same file the dashboard uses.
try { setLocalPrices(JSON.parse(fs.readFileSync(fileURLToPath(new URL('prices.local.json', import.meta.url)), 'utf8'))); } catch {}

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const transcript = input.transcript_path;
if (!transcript || !fs.existsSync(transcript)) { console.log(input.model?.display_name ?? ''); process.exit(0); }

const s = createState();
const load = (id, file) => {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try { const r = slim(JSON.parse(line)); if (r) ingest(s, id, r); } catch {}
  }
};
load('main', transcript);
const subDir = path.join(transcript.slice(0, -6), 'subagents');
for (const f of fs.existsSync(subDir) ? fs.readdirSync(subDir) : []) {
  const id = f.match(/^agent-(.+)\.jsonl$/)?.[1];
  if (!id) continue;
  try { ingestMeta(s, id, JSON.parse(fs.readFileSync(path.join(subDir, `agent-${id}.meta.json`), 'utf8'))); } catch {}
  load(id, path.join(subDir, f));
}

const sum = summary(s);
const part = a => {
  const [sym, v] = verb(a);
  return `${family(a.model)} ${sym} ${v === 'reading' ? `${a.files.size} files` : v}`;
};
const active = sum.subs.filter(a => stateOf(a) === 'working');
const parts = [sum.main && part(sum.main), ...active.slice(0, 3).map(part)].filter(Boolean);
if (active.length > 3) parts.push(`+${active.length - 3}`);
const money = n => n == null ? '?' : (sum.partial ? '≥$' : '$') + n.toFixed(2);
console.log(`${parts.join(' · ')} │ ${money(sum.cost)} vs ${money(sum.costIfMain)}`);
