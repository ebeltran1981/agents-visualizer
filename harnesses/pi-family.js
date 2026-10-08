// pi and its fork oh-my-pi write the same JSONL session format: one file per session,
// <root>/<encoded cwd>/<ISO timestamp>_<id>.jsonl, appended one record per line.
import fs from 'node:fs';
import path from 'node:path';
import { tail, summarize, verdictOf, tilde, every, installed, inside, cwdOf } from './common.js';

// oh-my-pi subagents hand back structured data with yield; PASS/FAIL usually sits in its status or result field.
const yieldVerdict = x => typeof x?.data === 'string' ? verdictOf(x.data)
  : [x?.data?.status, x?.data?.result, x?.data?.verdict].map(v => typeof v === 'string' && v.trim().toUpperCase()).find(v => v === 'PASS' || v === 'FAIL');

const yieldText = x => typeof x?.data === 'object' ? { summary: x.data.summary ?? x.data.notes ?? x.data.result, ...x.data } : x;

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

// Reduce one record to the shared format. ctx carries the session header's cwd and the current thinking level.
export function slim(o, ctx) {
  if (o.type === 'session') { ctx.cwd = tilde(o.cwd); return null; }
  if (o.type === 'thinking_level_change') { ctx.effort = o.thinkingLevel; return null; }
  const m = o.message;
  if (o.type !== 'message' || !m) return null;
  if (m.role === 'assistant') {
    const u = m.usage ?? {}, c = u.cost ?? {}, content = Array.isArray(m.content) ? m.content : [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return {
      t: 'a', ts: o.timestamp, id: o.id, model: m.model, effort: m.thinkingLevel ?? ctx.effort, cwd: ctx.cwd,
      u: { in: u.input ?? 0, out: u.output ?? 0, cr: u.cacheRead ?? 0, cw: (u.cacheWrite ?? 0) - (u.cacheWrite1h ?? 0), cw1h: u.cacheWrite1h ?? 0 },
      cost: c.total == null ? undefined : { total: c.total, in: (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0) },
      adv: [],
      tools: content.filter(b => b.type === 'toolCall')
        .map(b => ({ id: b.id, name: b.name, input: b.intent || summarize(b.name === 'yield' ? yieldText(b.arguments) : b.arguments), file: b.arguments?.path ?? b.arguments?.file_path,
                     verdict: b.name === 'yield' ? yieldVerdict(b.arguments) : undefined })),
      text: text.slice(0, 600) || undefined,
      verdict: verdictOf(text),
      error: m.stopReason === 'error' ? (m.errorMessage ?? 'model call failed').replace(/\s*\n\s*/g, ' · ').slice(0, 200) : undefined,
    };
  }
  if (m.role === 'toolResult') {
    // oh-my-pi's task tool names each subagent it ran (id = transcript file stem) and its agent type
    const metas = (m.details?.progress ?? []).filter(p => p.id).map(p => ({ a: (ctx.prefix ?? '') + p.id, meta: { agentType: p.agent, description: p.id } }));
    return { t: 'r', ts: o.timestamp, results: [{ err: !!m.isError, msg: m.isError ? textOf(m.content).slice(0, 160) : undefined }], metas };
  }
  const text = m.role === 'user' && !m.synthetic ? textOf(m.content).trim() : '';
  return text ? { t: 'p', ts: o.timestamp, text: text.slice(0, 200), cwd: ctx.cwd } : null;
}

// The header (line 1 in pi, line 2 in oh-my-pi) holds the real cwd.
const headerCwd = file => cwdOf(file, '"type":"session"[^\\n]*?');

export function piHarness({ id, label, bin, home, root, subagentsOf = () => [] }) {
  function listSessions(limit = 40) {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch {}
    for (const dir of dirs) {
      let files;
      try { files = fs.readdirSync(path.join(root, dir)); } catch { continue; }
      for (const f of files.filter(f => f.endsWith('.jsonl'))) {
        const p = path.join(root, dir, f), st = fs.statSync(p);
        if (!st.size) continue;
        out.push({ key: p, id: f.slice(f.indexOf('_') + 1, -6), cwd: headerCwd(p) ?? dir, mtime: st.mtimeMs, size: st.size });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  const resolve = arg => arg.endsWith('.jsonl') ? path.resolve(arg) : listSessions(Infinity).find(s => s.id === arg)?.key;
  const valid = key => !!key && inside(root, key) && key.endsWith('.jsonl') && fs.existsSync(key);

  // Same contract as harnesses/claude.js: push batches of { a, r } and { a, meta }; end() on a rewritten file.
  function watch(key, push, end) {
    const polls = new Map();
    let batch = [], stop;
    const follow = (agent, file) => {
      const ctx = { prefix: agent === 'main' ? '' : agent + '/' };
      polls.set(agent, tail(file, line => {
        try {
          const r = slim(JSON.parse(line), ctx);
          if (r?.metas) batch.push(...r.metas);
          if (r) batch.push({ a: agent, r });
        } catch {}
      }, () => { stop(); end(); }));
    };
    follow('main', key);
    const tick = () => {
      for (const s of subagentsOf(key)) if (!polls.has(s.id)) { batch.push({ a: s.id, meta: s.meta }); follow(s.id, s.file); }
      polls.forEach(poll => poll());
      push(batch);
      batch = [];
    };
    stop = every(500, tick, end);
    return () => stop();
  }

  return { id, label, bin, root: tilde(root), installed: installed(bin, home), listSessions, resolve, valid, watch };
}
