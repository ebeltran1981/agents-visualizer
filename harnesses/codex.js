// Codex: $CODEX_HOME (default ~/.codex) holds state_<n>.sqlite, whose threads table lists every session with the
// path of its JSONL transcript ("rollout"). Subagents are threads of their own, linked in thread_spawn_edges.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tail, summarize, clip, verdictOf, tilde, every, installed } from './common.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}  // built in, unflagged since Node 22.13

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// The schema version is part of the file name; take the newest.
function dbFile() {
  let files = [];
  try { files = fs.readdirSync(HOME).filter(f => /^state_\d+\.sqlite$/.test(f)); } catch {}
  const newest = files.sort((a, b) => parseInt(b.slice(6)) - parseInt(a.slice(6)))[0];
  return newest && path.join(HOME, newest);
}

// Read-only, as for opencode: a live connection while codex runs (its -wal file exists), immutable otherwise.
function rows(sql, ...args) {
  const file = dbFile();
  if (!DatabaseSync || !file) return [];
  const db = new DatabaseSync(fs.existsSync(file + '-wal') ? file : `${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

function listSessions(limit = 40) {
  return rows(`SELECT id, cwd, updated_at FROM threads WHERE thread_source != 'subagent' AND archived = 0
               ORDER BY updated_at DESC LIMIT ?`, limit)
    .map(t => ({ key: t.id, id: t.id, cwd: tilde(t.cwd), mtime: t.updated_at * 1000, size: 0 }));
}

// LIMIT -1 is no limit in SQLite.
const resolve = arg => listSessions(-1).find(s => s.id === arg || s.id.startsWith(arg))?.key;
const valid = key => /^[\w-]+$/.test(key ?? '') && rows('SELECT 1 FROM threads WHERE id = ?', key).length > 0;

const textOf = content => (Array.isArray(content) ? content : []).map(c => c.text ?? '').join('\n').trim();
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

// Codex runs everything through exec_command; name the call by what the command does, so it reads like other harnesses.
function toolOf(p) {
  const args = json(p.arguments), cmd = String(args.cmd ?? '');
  const tool = (name, input, file, full = input) => ({ id: p.call_id, name, input: summarize({ command: input }), full: clip(String(full)), file });
  if (p.name === 'exec_command') {
    // files written by a patch or a heredoc (cat > file <<'EOF')
    const written = [...cmd.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|\bcat\s*>+\s*([^\s<]+)\s*<</gm)].map(m => m[1] ?? m[2]);
    if (written.length) return tool('edit', written.join(', '), written[0], cmd);
    const read = cmd.match(/^(?:cat|head|tail|nl|sed -n '[^']*')(?: -\S+)* ([^\s|;&<>]+)$/);
    return read ? tool('read', read[1], read[1], cmd) : tool('bash', cmd);
  }
  if (p.name === 'spawn_agent') return tool('agent', args.message ?? '');
  return tool(p.name, args.message ?? (args.targets ?? [args.target]).filter(Boolean).join(', ') ?? '', undefined, p.arguments ?? '');
}

const failed = out => /^unsupported call|Process exited with code [1-9]|^Exit code: [1-9]/m.test(out.slice(0, 400));

// Reduce one record to the shared format. One model response is several records (reasoning, message, calls) followed by
// its usage record, so ctx.calls and ctx.text hold the response until the usage arrives.
export function slim(o, ctx) {
  const p = o.payload ?? {};
  if (o.type === 'session_meta') { ctx.cwd ??= tilde(p.cwd); return null; }  // a subagent's file repeats its parent's header after its own
  if (o.type === 'turn_context') { ctx.model = p.model ?? ctx.model; return null; }
  // a subagent's file starts with its parent's messages, replayed; its own begin once its settings are applied
  if (p.type === 'thread_settings_applied') { ctx.started = true; return null; }
  if (o.type === 'token_usage_record') {
    const u = p.usage ?? {}, cr = u.cached_input_tokens ?? 0, cw = u.cache_write_input_tokens ?? 0, text = ctx.text;
    const r = { t: 'a', ts: o.timestamp, id: p.response_id, model: ctx.model, effort: ctx.effort, cwd: ctx.cwd,
      u: { in: (u.input_tokens ?? 0) - cr - cw, out: u.output_tokens ?? 0, cr, cw, cw1h: 0 },  // input_tokens includes the cached ones
      adv: [], tools: ctx.calls, text: text ? clip(text) : undefined, verdict: text ? verdictOf(text) : undefined };
    ctx.calls = []; ctx.text = '';
    return r;
  }
  if (o.type !== 'response_item' || !ctx.started) return null;
  if (p.type === 'function_call') ctx.calls.push(toolOf(p));
  if (p.type === 'function_call_output') {
    const out = String(p.output ?? ''), err = failed(out);
    return { t: 'r', ts: o.timestamp, results: [{ err, msg: err ? clip(out) : undefined }] };
  }
  if (p.type !== 'message') return null;
  const text = textOf(p.content);
  if (p.role === 'assistant') ctx.text = text;
  // prompts only: codex also writes its own context (<environment_context>…) as user messages
  if (p.role === 'user' && text && !text.startsWith('<')) return { t: 'p', ts: o.timestamp, text: clip(text), cwd: ctx.cwd };
  return null;
}

// Pushes batches of { a: agentId, r: record } and { a, meta }; calls end() if a file is rewritten.
function watch(key, push, end) {
  const polls = new Map(), ctxs = new Map();
  let batch = [], stop;
  const follow = (agent, thread) => {
    const ctx = { calls: [], text: '', model: thread.model, effort: thread.reasoning_effort ?? undefined };
    ctxs.set(thread.id, ctx);
    polls.set(thread.id, tail(thread.rollout_path, line => {
      try { const r = slim(JSON.parse(line), ctx); if (r) batch.push({ a: agent, r }); } catch {}
    }, () => { stop(); end(); }));
  };
  const THREAD = 'SELECT id, rollout_path, model, reasoning_effort, agent_nickname, agent_role, title FROM threads';

  follow('main', rows(`${THREAD} WHERE id = ?`, key)[0]);
  const tick = () => {
    // threads spawned by any thread we follow are subagents
    for (const t of rows(`${THREAD} WHERE id IN (SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id IN (SELECT value FROM json_each(?)))`, JSON.stringify([...polls.keys()]))) {
      // a thread's effort is filled in shortly after it is spawned
      if (polls.has(t.id)) { ctxs.get(t.id).effort ??= t.reasoning_effort ?? undefined; continue; }
      batch.push({ a: t.id, meta: { agentType: t.agent_role ?? 'agent', description: [t.agent_nickname, t.title.split('\n')[0].slice(0, 80)].filter(Boolean).join(' · ') } });
      follow(t.id, t);
    }
    polls.forEach(poll => poll());
    push(batch);
    batch = [];
  };
  stop = every(500, tick, end);
  return () => stop();
}

// Shown instead of "no sessions" when this Node can't read codex's database at all.
const note = DatabaseSync ? undefined : 'codex needs Node 22.13 or later (node:sqlite)';

export default { id: 'codex', label: 'codex', bin: 'codex', root: tilde(HOME), note, installed: installed('codex', HOME), listSessions, resolve, valid, watch };
