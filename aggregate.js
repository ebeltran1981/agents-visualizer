// Harness-agnostic aggregation of normalized records (see harnesses/). Used by index.html and statusline.js.

// USD per 1M tokens. cacheWrite = 5-minute TTL write; 1-hour writes are billed at 2x input.
// Unknown models show "?" instead of a guessed price; add your own in prices.local.json.
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

// Company rates and names from prices.local.json; they take precedence over PRICES.
let LOCAL = {};
export function setLocalPrices(table = {}) {
  LOCAL = Object.fromEntries(Object.entries(table).map(([id, p]) => [id, { cacheRead: p.in, cacheWrite: p.in, ...p }]));
}

// Gateways add provider prefixes and version suffixes, e.g. us.anthropic.claude-opus-5-5-v1:0 or claude-haiku-4-5@20251001.
export const baseModel = m => (m ?? '').replace(/^([a-z]{2,4}\.)?anthropic\./, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '');

const lookup = (table, id) => table[Object.keys(table).sort((a, b) => b.length - a.length).find(k => id.startsWith(k))] ?? null;
const local = m => m ? lookup(LOCAL, m) ?? lookup(LOCAL, baseModel(m)) : null;

export const priceFor = m => m ? local(m) ?? lookup(PRICES, baseModel(m)) : null;

export function inputCost(model, u) {
  const p = priceFor(model);
  return p ? (u.in * p.in + u.cr * p.cacheRead + u.cw * p.cacheWrite + u.cw1h * p.in * 2) / 1e6 : null;
}

export function cost(model, u) {
  const c = inputCost(model, u);
  return c == null ? null : c + (u.out * priceFor(model).out) / 1e6;
}

export const readTokens = u => u.in + u.cr + u.cw + u.cw1h;
export const CLAUDE_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
// Claude models group by family (opus, sonnet…); any other model stands for itself.
export const family = m => local(m)?.family ?? baseModel(m).match(/^claude-([a-z]+)/)?.[1] ?? (baseModel(m) || '?');
export function shortModel(m) {
  if (!m) return '';
  const id = baseModel(m);
  return local(m)?.label ?? (id.startsWith('claude-') ? id.slice(7).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') : id);
}

const zero = () => ({ in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 });
const addU = (a, b, k = 1) => { for (const f in a) a[f] += k * (b[f] ?? 0); };

export function createState() {
  return { agents: new Map(), checks: { plan: 0, repeat: 0, done: 0 }, lastCheck: null, errs: new Set(), cwd: '', repeatPending: false, adv: { model: '', u: zero(), calls: 0, ts: 0, kind: null, lastIn: 0 } };
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
      // map a real call to the checkpoint it most likely is
      const subs = [...s.agents.values()].filter(b => b.id !== 'main' && b.lastTs);  // spawned, not just announced
      const kind = !subs.length ? 'plan' : s.repeatPending ? 'repeat' : subs.every(b => b.done || b.lastKind === 'text') ? 'done' : null;
      if (kind) check(kind);
      s.repeatPending = false;
      Object.assign(s.adv, { model: x.model, ts: a.lastTs, kind, lastIn: x.u.in + x.u.cr });
      row('advisor', `asks ${shortModel(x.model)} · it reads ${Math.round((x.u.in + x.u.cr) / 1000)}k tokens`, family(x.model));
    }
    a.usage.set(r.id, r);
    for (const t of r.tools) {
      a.tools++; a.lastKind = 'tool'; a.activity = t;
      if (t.file) a.files.add(t.file);
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) a.writes++;
      if (t.name === 'EnterPlanMode') check('plan');
      if (t.name === 'SubagentHandback') { a.done = true; a.final = t.input; a.verdict = undefined; }
      row(t.name, t.input, id === 'main' ? '' : `${family(a.model)} · ${a.effort}`);
    }
    if (!r.tools.length) {
      a.lastKind = r.text ? 'text' : 'thinking';
      if (r.text) { a.final = r.text; a.verdict = r.verdict; row('says', r.text.split('\n').find(Boolean)); }
    }
  } else if (r.t === 'r') {
    a.lastKind = 'result';
    for (const x of r.results.filter(x => x.err)) {
      a.errors++; row('error', x.msg, s.errs.has(x.msg) ? 'again' : '', true);
      if (s.errs.has(x.msg)) { check('repeat'); s.repeatPending = true; }
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
    return a.verdict ?? 'done';
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
  const mainModel = main?.model, advModel = s.adv.model || main?.advisor, mainPriced = !!priceFor(mainModel);
  const sum = (list, f) => list.reduce((t, a) => t + (f(a) ?? 0), 0);
  // Agents on unpriced models are left out of both sides of every comparison, and the totals are marked partial.
  const pricedAll = all.filter(a => priceFor(a.model)), pricedSubs = subs.filter(a => priceFor(a.model));
  const advU = priceFor(advModel) ? s.adv.u : null;
  const unpriced = [...new Set(all.map(a => a.model).concat(s.adv.calls ? advModel : []).filter(m => m && !priceFor(m)))];
  return {
    main, subs, mainModel, advModel, unpriced, partial: unpriced.length > 0, unpricedSubs: subs.length - pricedSubs.length,
    models: [...new Set(all.map(a => a.model).concat(advModel ?? []).filter(Boolean))],
    advCost: cost(advModel, s.adv.u),
    cost: sum(pricedAll, a => cost(a.model, a.u)) + (advU ? cost(advModel, advU) : 0),
    costIfMain: mainPriced ? sum(pricedAll, a => cost(mainModel, a.u)) + (advU ? cost(mainModel, advU) : 0) : null,
    readTokens: sum(pricedSubs, a => readTokens(a.u)),
    readCost: sum(pricedSubs, a => inputCost(a.model, a.u)),
    readCostIfMain: mainPriced ? sum(pricedSubs, a => inputCost(mainModel, a.u)) : null,
  };
}
