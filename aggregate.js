// Shared transcript parsing + aggregation. Used by server.js (slim), index.html and statusline.js.

// USD per 1M tokens. cacheWrite = 5-minute TTL write; 1-hour writes are billed at 2x input.
// Add a row for any new model; unknown models show "?" instead of a guessed price.
export const PRICES = {
  'claude-fable-5-1':  { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5':    { in: 10, out: 50, cacheRead: 1.00, cacheWrite: 12.5 },
  'claude-opus-5-5':   { in: 4,  out: 20, cacheRead: 0.20, cacheWrite: 5 },
  'claude-opus-5':     { in: 5,  out: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { in: 2,  out: 10, cacheRead: 0.20, cacheWrite: 2.5 },
  'claude-sonnet-5':   { in: 2,  out: 10, cacheRead: 0.20, cacheWrite: 2.5 },
  'claude-haiku-4-5':  { in: 1,  out: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
  // TODO: older models (opus-4-x, sonnet-4-x) if you replay old sessions.
};

export const EFFORT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const IDLE_MS = 45_000;

export function priceFor(model) {
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(k => model?.startsWith(k));
  return key ? PRICES[key] : null;
}

export function inputCost(model, u) {
  const p = priceFor(model);
  return p ? (u.in * p.in + u.cr * p.cacheRead + u.cw * p.cacheWrite + u.cw1h * p.in * 2) / 1e6 : null;
}

export function cost(model, u) {
  const c = inputCost(model, u);
  return c == null ? null : c + (u.out * priceFor(model).out) / 1e6;
}

export const readTokens = u => u.in + u.cr + u.cw + u.cw1h;
export const family = m => m?.split('-')[1] ?? '?';
export const shortModel = m => m?.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') ?? '?';

function summarize(x = {}) {
  const s = x.command ?? x.message ?? x.file_path ?? x.notebook_path ?? x.pattern ?? x.description ?? x.url ?? x.query
    ?? x.prompt ?? x.skill ?? Object.values(x).find(v => typeof v === 'string') ?? '';
  return String(s).split('\n')[0].slice(0, 160);
}

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? '').join(' ') : '';

// Reduce one raw JSONL record to the few fields the dashboard needs.
export function slim(o) {
  const m = o.message;
  if (o.type === 'assistant' && m) {
    const u = m.usage ?? {}, cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const content = Array.isArray(m.content) ? m.content : [];
    return {
      t: 'a', ts: o.timestamp, id: m.id, model: m.model, effort: o.effort, advisor: o.advisorModel, cwd: o.cwd,
      u: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0,
           cw: (u.cache_creation_input_tokens ?? 0) - cw1h, cw1h },
      // advisor calls report their own model and tokens here; top-level usage leaves them out
      adv: (u.iterations ?? []).filter(i => i.type === 'advisor_message').map(i => ({ model: i.model,
        u: { in: i.input_tokens ?? 0, out: i.output_tokens ?? 0, cr: i.cache_read_input_tokens ?? 0, cw: i.cache_creation_input_tokens ?? 0, cw1h: 0 } })),
      tools: content.filter(c => c.type === 'tool_use')
        .map(c => ({ id: c.id, name: c.name, input: summarize(c.input), file: c.input?.file_path ?? c.input?.notebook_path })),
      text: content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 600) || undefined,
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

const zero = () => ({ in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 });
const addU = (a, b, k = 1) => { for (const f in a) a[f] += k * (b[f] ?? 0); };

export function createState() {
  return { agents: new Map(), checks: { plan: 0, repeat: 0, done: 0 }, lastCheck: null, errs: new Set(), cwd: '', adv: { model: '', u: zero(), calls: 0, ts: 0 } };
}

function agentOf(s, id) {
  if (!s.agents.has(id)) s.agents.set(id, {
    id, n: s.agents.size, type: id === 'main' ? 'main' : 'agent', desc: '', model: '', effort: '', advisor: '',
    u: zero(), usage: new Map(), files: new Set(), tools: 0, writes: 0, errors: 0, lastKind: '', activity: null, final: '', lastTs: 0,
  });
  return s.agents.get(id);
}

export const label = a => a.id === 'main' ? 'main' : `${a.type}#${a.n}`;

export function ingestMeta(s, id, meta) {
  const a = agentOf(s, id);
  a.type = meta.agentType ?? a.type;
  a.desc = meta.description ?? a.desc;
}

// Apply one slimmed record; returns new log rows.
export function ingest(s, id, r) {
  const a = agentOf(s, id), rows = [];
  const row = (action, detail, note = '', err = false) => rows.push({ ts: r.ts, agent: label(a), fam: family(a.model), action, detail, note, err });
  const check = kind => { s.checks[kind]++; s.lastCheck = { kind, ts: a.lastTs }; };
  a.lastTs = Date.parse(r.ts) || a.lastTs;
  if (r.cwd && id === 'main') s.cwd = r.cwd;

  if (r.t === 'a') {
    if (!r.model || r.model.startsWith('<')) return rows;  // synthetic messages
    Object.assign(a, { model: r.model, effort: r.effort ?? a.effort, advisor: r.advisor ?? a.advisor });
    // One API message is split over several lines that repeat its usage: count it once.
    const prev = a.usage.get(r.id);
    if (prev) { addU(a.u, prev.u, -1); prev.adv.forEach(x => addU(s.adv.u, x.u, -1)); s.adv.calls -= prev.adv.length; }
    addU(a.u, r.u); r.adv.forEach(x => addU(s.adv.u, x.u)); s.adv.calls += r.adv.length;
    for (const x of r.adv.slice(prev?.adv.length ?? 0)) {
      Object.assign(s.adv, { model: x.model, ts: a.lastTs });
      row('advisor', `asks ${shortModel(x.model)} · it reads ${Math.round((x.u.in + x.u.cr) / 1000)}k tokens`, family(x.model));
    }
    a.usage.set(r.id, r);
    for (const t of r.tools) {
      a.tools++; a.lastKind = 'tool'; a.activity = t;
      if (t.file) a.files.add(t.file);
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) a.writes++;
      if (t.name === 'EnterPlanMode') check('plan');
      if (t.name === 'SubagentHandback') { a.done = true; a.final = t.input; }
      row(t.name, t.input, id === 'main' ? '' : `${family(a.model)} · ${a.effort}`);
    }
    if (!r.tools.length) {
      a.lastKind = r.text ? 'text' : 'thinking';
      if (r.text) { a.final = r.text; row('says', r.text.split('\n').find(Boolean)); }
    }
  } else if (r.t === 'r') {
    a.lastKind = 'result';
    for (const x of r.results.filter(x => x.err)) {
      a.errors++; row('error', x.msg, s.errs.has(x.msg) ? 'again' : '', true);
      if (s.errs.has(x.msg)) check('repeat');
      s.errs.add(x.msg);
    }
  } else if (r.t === 'p') {
    if (id === 'main' && a.lastKind === 'text') check('done');
    a.lastKind = 'prompt';
    row(id === 'main' ? 'prompt' : 'task', r.text);
  }
  return rows;
}

// idle | working | done | PASS | FAIL
export function stateOf(a, now = Date.now()) {
  if (a.id !== 'main' && (a.done || a.lastKind === 'text')) {
    if (/\bFAIL(ED|ING|S)?\b/.test(a.final)) return 'FAIL';
    if (/\bPASS(ED|ES)?\b/.test(a.final)) return 'PASS';
    return 'done';
  }
  return a.lastKind !== 'text' && now - a.lastTs < IDLE_MS ? 'working' : 'idle';
}

const VERBS = [[/^(Read|Grep|Glob)$/, '▸', 'reading'], [/^(Edit|Write|MultiEdit|NotebookEdit)$/, '✎', 'editing'],
  [/^Bash$/, '$', 'running'], [/PlanMode/, '●', 'plan'], [/^(Agent|Task)$/, '⇢', 'delegating'], [/^Web/, '↯', 'browsing']];

export function verb(a) {
  if (a.lastKind === 'thinking') return ['●', 'thinking'];
  const v = a.activity && VERBS.find(([re]) => re.test(a.activity.name));
  return v ? [v[1], v[2]] : ['·', a.activity?.name ?? 'idle'];
}

export function summary(s) {
  const all = [...s.agents.values()], main = s.agents.get('main'), subs = all.filter(a => a.id !== 'main');
  const mainModel = main?.model, advModel = s.adv.model || main?.advisor;
  const sum = (list, f) => list.reduce((t, a) => t + (f(a) ?? 0), 0);
  return {
    main, subs, mainModel, advModel,
    models: [...new Set(all.map(a => a.model).concat(advModel ?? []).filter(Boolean))],
    advCost: cost(advModel, s.adv.u),
    cost: sum(all, a => cost(a.model, a.u)) + (cost(advModel, s.adv.u) ?? 0),
    costIfMain: sum(all, a => cost(mainModel, a.u)) + (cost(mainModel, s.adv.u) ?? 0),
    readTokens: sum(subs, a => readTokens(a.u)),
    readCost: sum(subs, a => inputCost(a.model, a.u)),
    readCostIfMain: sum(subs, a => inputCost(mainModel, a.u)),
    unpriced: [...new Set(all.map(a => a.model).concat(s.adv.calls ? advModel : []).filter(m => m && !priceFor(m)))],
  };
}
