// opencode: one SQLite database ($OPENCODE_DB, default ~/.local/share/opencode/opencode.db) with session, message
// and part tables. Rows are rewritten in place as a session runs, so this adapter polls and emits each item once.
// Subagents are child sessions (session.parent_id) created by the task tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, verdictOf, tilde, every } from './common.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}  // built in, unflagged since Node 22.13

const DB = process.env.OPENCODE_DB || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');

// Read-only, and without creating anything next to the database: while opencode is writing, its -wal file
// already exists and a read-only connection sees live writes; otherwise the file is opened as immutable.
function open() {
  if (!DatabaseSync || !fs.existsSync(DB)) return null;
  const live = fs.existsSync(DB + '-wal');
  return { live, db: new DatabaseSync(live ? DB : `file:${DB}?immutable=1`, { readOnly: true }) };
}

const rows = (sql, ...args) => { const c = open(); if (!c) return []; try { return c.db.prepare(sql).all(...args); } finally { c.db.close(); } };

function listSessions(limit = 40) {
  return rows(`SELECT id, directory, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL
               ORDER BY time_updated DESC LIMIT ?`, limit)
    .map(s => ({ key: s.id, id: s.id.replace(/^ses_/, ''), cwd: tilde(s.directory), mtime: s.time_updated, size: 0 }));
}

const resolve = arg => listSessions(Infinity).find(s => s.key === arg || s.id === arg)?.key;
const valid = key => /^[\w-]+$/.test(key ?? '') && rows('SELECT 1 FROM session WHERE id = ?', key).length > 0;

const iso = ms => new Date(ms).toISOString();
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

function watch(key, push, end) {
  let conn = open();
  const agents = new Map();  // session id → per-agent cursor
  const follow = (sid, agent) => agents.set(sid, { agent, maxPart: '', pending: new Set(), usage: {}, done: new Set() });
  follow(key, 'main');

  function poll(sid, s, batch) {
    const q = sql => conn.db.prepare(sql);
    const msgs = new Map(q('SELECT id, data, time_created FROM message WHERE session_id = ?').all(sid).map(m => [m.id, { ...json(m.data), id: m.id, created: m.time_created }]));  // ids live in columns, not in data
    // new parts, plus tool parts that weren't finished last time
    const parts = q(`SELECT id, message_id, data, time_created FROM part WHERE session_id = ? AND (id > ? OR id IN (SELECT value FROM json_each(?)))
                     ORDER BY id`).all(sid, s.maxPart, JSON.stringify([...s.pending]));
    const a = (m, ts, extra) => ({ t: 'a', ts: iso(ts), id: m.id, model: m.modelID, effort: m.variant, cwd: tilde(m.path?.cwd),
      u: s.usage[m.id] ?? { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 }, adv: [], tools: [], ...extra });

    for (const p of parts) {
      const d = json(p.data), m = { ...msgs.get(p.message_id), id: p.message_id };
      if (p.id > s.maxPart) s.maxPart = p.id;
      if (d.type === 'step-finish') {  // message tokens hold only the last step, so sum the steps
        const t = d.tokens ?? {}, u = s.usage[m.id] ??= { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 };
        Object.assign(u, { in: u.in + (t.input ?? 0), out: u.out + (t.output ?? 0) + (t.reasoning ?? 0), cr: u.cr + (t.cache?.read ?? 0), cw: u.cw + (t.cache?.write ?? 0) });
      } else if (d.type === 'text' && m.role === 'user' && !d.synthetic && d.text && !s.done.has(p.id)) {
        s.done.add(p.id);
        batch.push({ a: s.agent, r: { t: 'p', ts: iso(p.time_created), text: d.text.trim().slice(0, 200), cwd: tilde(m.path?.cwd) } });
      } else if (d.type === 'tool') {
        const st = d.state ?? {}, input = st.input ?? {};
        if (!s.done.has(p.id + ':call')) {
          s.done.add(p.id + ':call');
          batch.push({ a: s.agent, r: a(m, st.time?.start ?? p.time_created, { tools: [{ id: d.callID, name: d.tool, input: st.title || summarize(input), file: input.filePath ?? input.path }] }) });
        }
        if (st.status === 'completed' || st.status === 'error') {
          s.pending.delete(p.id);
          batch.push({ a: s.agent, r: { t: 'r', ts: iso(st.time?.end ?? p.time_created), results: [{ err: st.status === 'error', msg: st.error?.slice?.(0, 160) }] } });
        } else s.pending.add(p.id);
      }
    }

    // a finished assistant message carries its final text and token totals
    for (const m of msgs.values()) {
      if (m.role !== 'assistant' || !m.time?.completed || s.done.has(m.id)) continue;
      s.done.add(m.id);
      const text = q("SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id").all(m.id)
        .map(r => json(r.data).text ?? '').join('\n');
      batch.push({ a: s.agent, r: a(m, m.time.completed, { text: text.slice(0, 600) || undefined, verdict: verdictOf(text) }) });
      if (m.error) batch.push({ a: s.agent, r: { t: 'r', ts: iso(m.time.completed), results: [{ err: true, msg: String(m.error.data?.message ?? m.error.name).slice(0, 160) }] } });
    }
  }

  const tick = () => {
    if (!conn) conn = open();
    if (!conn) return;
    if (!conn.live && fs.existsSync(DB + '-wal')) { close(); return end(); }  // opencode started writing: reconnect live
    const batch = [];
    for (const [sid, s] of agents) {
      // children of every agent we follow are subagents (the task tool's child sessions)
      for (const c of conn.db.prepare('SELECT id, agent, title FROM session WHERE parent_id = ?').all(sid)) {
        if (agents.has(c.id)) continue;
        batch.push({ a: c.id, meta: { agentType: c.agent ?? 'subagent', description: (c.title ?? '').replace(/\s*\(@\S+ subagent\)$/, '') } });
        follow(c.id, c.id);
      }
      poll(sid, s, batch);
    }
    push(batch);
  };
  let stop = () => {};
  const close = () => { stop(); conn?.db.close(); conn = null; };
  stop = every(1000, tick, () => { close(); end(); });
  return () => conn && close();
}

export default { id: 'opencode', label: 'opencode', bin: 'opencode', root: tilde(DB), listSessions, resolve, valid, watch };
