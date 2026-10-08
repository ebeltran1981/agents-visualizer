// Claude Code: ~/.claude/projects/<project>/<session>.jsonl, subagents in <session>/subagents/agent-<id>.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tail, summarize, verdictOf, tilde, every } from './common.js';

const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? '').join(' ') : '';

// Reduce one raw JSONL record to the few fields the dashboard needs.
export function slim(o) {
  const m = o.message;
  if (o.type === 'assistant' && m) {
    const u = m.usage ?? {}, cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const content = Array.isArray(m.content) ? m.content : [];
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return {
      t: 'a', ts: o.timestamp, id: m.id, model: m.model, effort: o.effort, advisor: o.advisorModel, cwd: o.cwd,
      u: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0,
           cw: (u.cache_creation_input_tokens ?? 0) - cw1h, cw1h },
      // advisor calls report their own model and tokens here; top-level usage leaves them out
      adv: (u.iterations ?? []).filter(i => i.type === 'advisor_message').map(i => ({ model: i.model,
        u: { in: i.input_tokens ?? 0, out: i.output_tokens ?? 0, cr: i.cache_read_input_tokens ?? 0, cw: i.cache_creation_input_tokens ?? 0, cw1h: 0 } })),
      tools: content.filter(c => c.type === 'tool_use')
        .map(c => ({ id: c.id, name: c.name, input: summarize(c.input), file: c.input?.file_path ?? c.input?.notebook_path })),
      text: text.slice(0, 600) || undefined,
      verdict: verdictOf(text),
    };
  }
  if (o.type === 'user' && m) {
    const results = Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result') : [];
    if (results.length) return { t: 'r', ts: o.timestamp, results: results.map(r => ({ err: !!r.is_error, msg: r.is_error ? textOf(r.content).slice(0, 160) : undefined })) };
    const text = textOf(m.content).trim();
    if (!o.isMeta && text && !text.startsWith('<')) return { t: 'p', ts: o.timestamp, text: text.slice(0, 200), cwd: o.cwd };
  }
  return null;
}

// Folder names turn '/' into '-', which is lossy, so read the real cwd from the transcript head.
function cwdOf(file) {
  const buf = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  const head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  fs.closeSync(fd);
  return tilde(head.match(/"cwd":"([^"]+)"/)?.[1]);
}

function listSessions(limit = 40) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT); } catch {}
  for (const project of projects) {
    let files;
    try { files = fs.readdirSync(path.join(ROOT, project)); } catch { continue; }
    for (const f of files.filter(f => f.endsWith('.jsonl'))) {
      const p = path.join(ROOT, project, f), st = fs.statSync(p);
      if (!st.size) continue;
      out.push({ key: p, id: f.slice(0, -6), cwd: cwdOf(p) ?? project, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// --session accepts a transcript path or a session id.
const resolve = arg => arg.endsWith('.jsonl') ? path.resolve(arg) : listSessions(Infinity).find(s => s.id === arg)?.key;

const valid = key => !!key && path.resolve(key).startsWith(ROOT + path.sep) && key.endsWith('.jsonl') && fs.existsSync(key);

// Pushes batches of { a: agentId, r: record } and { a, meta }; calls end() if a file is rewritten.
function watch(key, push, end) {
  const subDir = path.join(key.slice(0, -6), 'subagents');
  const polls = new Map();
  let batch = [], stop;
  const follow = (id, file) => polls.set(id, tail(file, line => {
    try { const r = slim(JSON.parse(line)); if (r) batch.push({ a: id, r }); } catch {}
  }, () => { stop(); end(); }));

  follow('main', key);
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
    push(batch);
    batch = [];
  };
  stop = every(500, tick, end);
  return () => stop();
}

export default { id: 'claude', label: 'claude code', bin: 'claude', root: tilde(ROOT), listSessions, resolve, valid, watch };
