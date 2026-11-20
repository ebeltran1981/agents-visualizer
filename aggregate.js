// Harness-agnostic aggregation of normalized records (see harnesses/). Used by index.html and statusline.js.

// USD per 1M tokens. cacheWrite = 5-minute TTL write; 1-hour writes are billed at 2x input.
// Unknown models show "?" instead of a guessed price; add your own in prices.local.json.
export const PRICES = {
  'claude-fable-5-2':  { in: 8,  out: 40, cacheRead: 0.20, cacheWrite: 10 },
  'claude-fable-5-1':  { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5':    { in: 10, out: 50, cacheRead: 1.00, cacheWrite: 12.5 },
  'claude-opus-5-5':   { in: 4,  out: 20, cacheRead: 0.20, cacheWrite: 5 },
  'claude-opus-5':     { in: 5,  out: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { in: 2,  out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  'claude-sonnet-5':   { in: 2,  out: 10, cacheRead: 0.20, cacheWrite: 2.5 },
  // Haiku 5.5 bills a request with more than 100k prompt tokens at 5x these rates; per-agent totals cannot show that.
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5':  { in: 1,  out: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
  // TODO: older models (opus-4-x, sonnet-4-x) if you replay old sessions.
};

export const EFFORT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const IDLE_MS = 45_000;
// An advisor writes nothing while it thinks, so wait longer than IDLE_MS before calling a review stalled.
const REVIEW_MS = 300_000;
// Anthropic's two cache lifetimes; every request that reads the cache restarts its clock.
const TTL_5M = 300_000, TTL_1H = 3_600_000;

// Company rates and names from prices.local.json; they take precedence over PRICES.
let LOCAL = {};
export function setLocalPrices(table = {}) {
  LOCAL = Object.fromEntries(Object.entries(table).map(([id, p]) => [id, { cacheRead: p.in, cacheWrite: p.in, ...p }]));
}

// Gateways add provider prefixes and version suffixes, e.g. global.anthropic.claude-sonnet-5-5, us.anthropic.claude-opus-5-5-v1:0 or claude-haiku-4-5@20251001.
export const baseModel = m => (m ?? '').replace(/^([a-z-]{2,8}\.)?anthropic\./, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '');

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

// Your local prices first, then the cost the harness reported (pi and its forks record it), then the list price.
// A reported total of exactly 0 (pi with a model that has no price) is no cost at all, not a free session.
const usesPaid = a => a.paid.total > 0 && !local(a.model);
export const agentCost = a => usesPaid(a) ? a.paid.total : cost(a.model, a.u);
// Only pi-family harnesses split their cost into input and output; otherwise fall back to the price table.
const agentInputCost = a => usesPaid(a) && a.paid.inN === a.paid.n ? a.paid.in : inputCost(a.model, a.u);
export const priced = a => a.paid.total > 0 || !!priceFor(a.model);

export const readTokens = u => u.in + u.cr + u.cw + u.cw1h;
export const hitRate = u => readTokens(u) ? u.cr / readTokens(u) : null;
export const CLAUDE_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
// Claude models group by family (opus, sonnet…); any other model stands for itself.
export const family = m => local(m)?.family ?? baseModel(m).match(/^claude-([a-z]+)/)?.[1] ?? (baseModel(m) || '?');
// One colour per model family. A family is found anywhere in the name (us.anthropic.claude-opus-5-5-v1:0, kimi-k3:cloud),
// so gateway prefixes and suffixes don't matter. First match wins. Red is kept for errors.
const FAMILY_COLORS = [
  ['opus', '#b6f36a'], ['sonnet', '#6ad8f3'], ['haiku', '#f3c76a'], ['fable', '#f36ad8'], ['mythos', '#f36ad8'],
  ['gpt', '#6af3b0'], ['codex', '#6af3b0'], ['deepseek', '#6a9df3'], ['kimi', '#a78bfa'], ['moonshot', '#a78bfa'],
  ['glm', '#f3956a'], ['nova', '#ece76a'], ['titan', '#ece76a'], ['qwen', '#cf8af3'], ['minimax', '#5fd9c4'],
  ['llama', '#d9c4a0'], ['gemini', '#8fb4ff'], ['gemma', '#8fb4ff'], ['mistral', '#ffb38a'], ['grok', '#e8ecdf'],
];
const PALETTE = ['#6af3b0', '#6a9df3', '#a78bfa', '#f3956a', '#ece76a', '#cf8af3', '#8fb4ff', '#5fd9c4'];

// A model's colour: the one set in prices.local.json, else its family's, else one picked from its name.
export function colorOf(m) {
  if (!m) return '';
  const own = local(m);
  if (own?.color) return own.color;
  const name = `${own?.family ?? ''} ${m}`.toLowerCase();
  const known = FAMILY_COLORS.find(([f]) => name.includes(f));
  if (known) return known[1];
  let h = 0;
  for (const ch of baseModel(m)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function shortModel(m) {
  if (!m) return '';
  const id = baseModel(m);
  return local(m)?.label ?? (id.startsWith('claude-') ? id.slice(7).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') : id);
}

const zero = () => ({ in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 });
const paidOf = c => ({ ...c, n: 1, inN: c.in == null ? 0 : 1 });

// Retried errors differ only in a request id, so compare them without it, on their start as the adapters once cut them.
const errKey = msg => String(msg).slice(0, 160).replace(/\(ref: [^)]*\)|req_\w+/g, '');
const addU = (a, b, k = 1) => { for (const f in a) a[f] += k * (b[f] ?? 0); };

export function createState() {
  return { agents: new Map(), checks: { plan: 0, repeat: 0, done: 0 }, lastCheck: null, errs: new Set(), cwd: '', repeatPending: false, adv: { model: '', u: zero(), paid: { total: 0, in: 0, n: 0, inN: 0 }, calls: 0, ts: 0, kind: null, lastIn: 0 } };
}

function agentOf(s, id) {
  if (!s.agents.has(id)) s.agents.set(id, {
    id, n: [...s.agents.values()].filter(b => b.type !== 'advisor').length,  // advisors take no card number
    type: id === 'main' ? 'main' : 'agent', desc: '', model: '', effort: '', advisor: '',
    u: zero(), paid: { total: 0, in: 0, n: 0, inN: 0 }, usage: new Map(), files: new Set(), tools: 0, writes: 0, errors: 0, lastKind: '', activity: null, final: '', lastTs: 0,
    breaks: [], ttl: 0, lastReq: null, cacheTs: 0,
  });
  return s.agents.get(id);
}

export const label = a => a.id === 'main' ? 'main' : a.type === 'advisor' ? 'advisor' : `${a.type}#${a.n}`;

export function ingestMeta(s, id, meta) {
  const a = agentOf(s, id);
  a.type = /(^|:)advisor$/.test(meta.agentType) ? 'advisor' : meta.agentType ?? a.type;  // a plugin's advisor agent is "advisor:advisor"
  a.desc = meta.description ?? a.desc;
}

// Apply one slimmed record; returns new log rows.
export function ingest(s, id, r) {
  const a = agentOf(s, id), rows = [];
  // detail is the row's text, kept short for the DOM; full is the whole message behind it
  const row = (action, detail = '', note = '', err = false, full = detail) => rows.push({ ts: r.ts, agent: label(a), fam: family(a.model), model: a.model, action, detail: detail.slice(0, 300), full, note, err });
  const check = kind => { s.checks[kind]++; s.lastCheck = { kind, ts: a.lastTs }; };
  const fail = msg => {
    const seen = s.errs.has(errKey(msg));
    a.errors++; row('error', msg, seen ? 'again' : '', true);
    if (seen) { check('repeat'); s.repeatPending = true; }
    s.errs.add(errKey(msg));
  };
  // A request that reads back less than half of what the previous one left cached paid to write it again: a cache break.
  // Only single requests are compared; usage summed over several model runs (summed) just keeps the cache warm.
  const cacheTurn = single => {
    const last = a.lastReq, fresh = r.u.in + r.u.cw + r.u.cw1h;
    if (single && last && r.u.cr < readTokens(last.u) / 2 && fresh > 1000) {
      const gap = Date.parse(r.ts) - Date.parse(last.ts);
      const cause = last.model !== r.model ? 'model changed'
        : gap > (a.ttl || TTL_5M) ? `idle ${Math.round(gap / 60_000)} min${a.ttl ? ` > ${a.ttl === TTL_1H ? '1h' : '5 min'} cache` : ''}`
        : 'context changed';
      const c = inputCost(r.model, { ...r.u, cr: 0 });
      a.breaks.push({ id: r.id, ts: r.ts, cause, tokens: fresh, cost: c });
      row('cache', `rewrote ${Math.round(fresh / 1000)}k · ${cause}${c == null ? '' : ` · $${c.toFixed(2)}`}`);
    }
    if (single) a.lastReq = r;
    if (r.u.cw1h) a.ttl = TTL_1H;
    else if (r.u.cw && !a.ttl) a.ttl = TTL_5M;
    a.cacheTs = Math.max(a.cacheTs, Date.parse(r.ts));
  };
  a.lastTs = Date.parse(r.ts) || a.lastTs;
  if (r.cwd && id === 'main') s.cwd = r.cwd;
  // Map an advisor call to the checkpoint it most likely is.
  const advisorCall = (model, lastIn) => {
    const subs = [...s.agents.values()].filter(b => b.id !== 'main' && b.type !== 'advisor' && b.lastTs);  // spawned, not just announced
    const kind = !subs.length ? 'plan' : s.repeatPending ? 'repeat' : subs.every(b => b.done || b.lastKind === 'text') ? 'done' : null;
    if (kind) check(kind);
    s.repeatPending = false;
    Object.assign(s.adv, { model, ts: a.lastTs, kind, lastIn });
  };

  // An advisor that runs as its own transcript (oh-my-pi, the Claude Code advisor plugin) feeds the advisor panel, one call per review it finishes.
  if (a.type === 'advisor') {
    if (r.t === 'p') {
      a.reviewing = !r.text.startsWith('[Request interrupted');
      a.lastKind = 'prompt';
      if (!a.reviewing) a.activity = null;
    }
    if (r.t === 'r') a.lastKind = 'result';  // a result never starts a review: the result of the advise tool comes after it ended
    if (r.t !== 'a' || !r.model) return rows;
    const failed = r.error || r.model.startsWith('<');  // an API error line, not a review
    const replied = !failed && r.text && !r.tools.length && !r.partial;
    const advise = r.tools.find(t => t.name === 'advise');  // oh-my-pi delivers its advice as a note in this tool call
    if (!failed) { a.model = r.model; s.adv.model ||= r.model; }  // the panel names the model from the first line, before the first call ends
    for (const t of r.tools) { a.activity = t; a.lastKind = 'tool'; if (t.file) a.files.add(t.file); }
    if (!r.tools.length) a.lastKind = r.text ? 'text' : 'thinking';
    // a review ends with a reply, an advise call, an API error or an interrupt
    a.reviewing = !(failed || replied || advise);
    if (!a.reviewing) a.activity = null;
    const prev = a.usage.get(r.id);
    if (prev) { addU(s.adv.u, prev.u, -1); if (prev.cost) addU(s.adv.paid, paidOf(prev.cost), -1); }
    addU(s.adv.u, r.u); if (r.cost) addU(s.adv.paid, paidOf(r.cost));
    // Lines of one message share its id, so count the call once per id, on its finished text line.
    a.usage.set(r.id, { ...r, counted: prev?.counted });
    if ((replied || advise) && !prev?.counted) {
      a.usage.get(r.id).counted = true;
      s.adv.calls++;
      advisorCall(r.model, readTokens(r.u));
      row('advisor', advise ? advise.input : r.text.split('\n').find(Boolean), family(r.model), false, advise ? advise.full : r.text);
    }
    return rows;
  }

  if (r.t === 'a') {
    if (!r.model || r.model.startsWith('<')) return rows;  // synthetic messages
    Object.assign(a, { model: r.model, effort: r.effort ?? a.effort, advisor: r.advisor ?? a.advisor });
    // One API message is split over several lines that repeat its usage: count it once.
    const prev = a.usage.get(r.id);
    if (readTokens(r.u)) cacheTurn(!prev && !r.summed);
    if (prev) { addU(a.u, prev.u, -1); prev.adv.forEach(x => addU(s.adv.u, x.u, -1)); s.adv.calls -= prev.adv.length; }
    if (prev?.cost) addU(a.paid, paidOf(prev.cost), -1);
    if (r.cost) addU(a.paid, paidOf(r.cost));
    addU(a.u, r.u); r.adv.forEach(x => addU(s.adv.u, x.u)); s.adv.calls += r.adv.length;
    for (const x of r.adv.slice(prev?.adv.length ?? 0)) {
      advisorCall(x.model, readTokens(x.u));
      row('advisor', `asks ${shortModel(x.model)} · it reads ${Math.round(readTokens(x.u) / 1000)}k tokens`, family(x.model));
    }
    a.usage.set(r.id, r);
    for (const t of r.tools) {
      a.tools++; a.lastKind = 'tool'; a.activity = t;
      if (t.file) a.files.add(t.file);
      if (/^(edit|write|multiedit|notebookedit)$/i.test(t.name)) a.writes++;
      if (t.name === 'EnterPlanMode') check('plan');
      if (/^(SubagentHandback|yield)$/.test(t.name)) { a.done = true; a.final = t.input; a.verdict = t.verdict ?? a.verdict; }  // a subagent handing back its result
      row(t.name, t.input, id === 'main' ? '' : `${family(a.model)} · ${a.effort}`, false, t.full);
    }
    if (!r.tools.length) {
      a.lastKind = r.text ? 'text' : 'thinking';
      if (r.text) { a.final = r.text; a.verdict = r.verdict; row('says', r.text.split('\n').find(Boolean), '', false, r.text); }
    }
    // a model call that failed outright (say, a retired model) ends the agent unless a later turn succeeds
    if (r.error) { fail(r.error); Object.assign(a, { lastKind: 'text', final: r.error, verdict: 'FAIL' }); }
  } else if (r.t === 'r') {
    a.lastKind = 'result';
    for (const x of r.results.filter(x => x.err)) fail(x.msg);
  } else if (r.t === 'p') {
    if (id === 'main' && a.lastKind === 'text') check('done');
    a.lastKind = 'prompt';
    row(id === 'main' ? 'prompt' : 'task', r.text);
  }
  return rows;
}

// Cache use by main and subagents: hit rate, money saved, breaks, subagent warm-up, and how long main's cache stays warm.
export function cacheSummary(s) {
  const all = [...s.agents.values()].filter(a => a.type !== 'advisor'), main = s.agents.get('main');
  const subs = all.filter(a => a.id !== 'main' && a.usage.size);
  const sum = (list, f) => list.reduce((t, x) => t + (f(x) ?? 0), 0);
  const u = zero();
  all.forEach(a => addU(u, a.u));
  // the read discount minus the write premium (5-minute writes cost cacheWrite, 1-hour writes twice the input price)
  const saved = a => {
    const p = priceFor(a.model);
    return p ? (a.u.cr * (p.in - p.cacheRead) - a.u.cw * (p.cacheWrite - p.in) - a.u.cw1h * p.in) / 1e6 : null;
  };
  const warmup = a => { const first = [...a.usage.values()][0]; return inputCost(first.model, { ...first.u, cr: 0 }); };
  const breaks = all.flatMap(a => a.breaks.map(b => ({ ...b, agent: label(a) }))).sort((x, y) => x.ts.localeCompare(y.ts));

  const last = main?.lastReq, ttl = main?.ttl || null;
  const prefix = last ? readTokens(last.u) : 0;
  const brk = new Set(main?.breaks.map(b => b.id));
  const anyPriced = list => list.some(a => priceFor(a.model));
  return {
    u, hit: hitRate(u), saved: anyPriced(all) ? sum(all, saved) : null, unpriced: all.filter(a => readTokens(a.u) && !priceFor(a.model)).length,
    tracked: all.some(a => a.lastReq),  // breaks need single requests, which opencode doesn't record
    breaks, breakCost: sum(breaks, b => b.cost), warmup: anyPriced(subs) ? sum(subs, warmup) : null, warmupN: subs.length,
    main: {
      ttl, prefix,
      expiresAt: ttl ? main.cacheTs + ttl : null,
      rewriteCost: last && ttl ? inputCost(last.model, { ...zero(), [ttl === TTL_1H ? 'cw1h' : 'cw']: prefix }) : null,
      series: main ? [...main.usage.values()].filter(r => !r.summed && readTokens(r.u)).map(r => ({ cr: r.u.cr, brk: brk.has(r.id) })) : [],
    },
  };
}

// idle | working | done | PASS | FAIL
export function stateOf(a, now = Date.now()) {
  if (a.id !== 'main' && (a.done || a.lastKind === 'text')) {
    return a.verdict ?? 'done';
  }
  return a.lastKind !== 'text' && now - a.lastTs < IDLE_MS ? 'working' : 'idle';
}

// The latest advisor agent, when it is mid-review.
export function reviewing(s, now = Date.now()) {
  const last = [...s.agents.values()].filter(a => a.type === 'advisor').sort((x, y) => y.lastTs - x.lastTs)[0];
  return last?.reviewing && now - last.lastTs < REVIEW_MS ? last : undefined;
}

// Tool names differ in case across harnesses (Read in Claude Code, read in pi).
const VERBS = [[/^(read|grep|glob|find|ls)$/i, '▸', 'reading'], [/^(edit|write|multiedit|notebookedit)$/i, '✎', 'editing'],
  [/^bash$/i, '$', 'running'], [/PlanMode/, '●', 'plan'], [/^(agent|task)$/i, '⇢', 'delegating'], [/^web/i, '↯', 'browsing']];

export function verb(a) {
  if (a.lastKind === 'thinking') return ['●', 'thinking'];
  const v = a.activity && VERBS.find(([re]) => re.test(a.activity.name));
  return v ? [v[1], v[2]] : ['·', a.activity?.name ?? 'idle'];
}

export function summary(s) {
  const all = [...s.agents.values()].filter(a => a.type !== 'advisor'), main = s.agents.get('main'), subs = all.filter(a => a.id !== 'main');
  const mainModel = main?.model, advModel = s.adv.model || main?.advisor, mainPriced = !!priceFor(mainModel);
  const sum = (list, f) => list.reduce((t, a) => t + (f(a) ?? 0), 0);
  // Agents on unpriced models are left out of both sides of every comparison, and the totals are marked partial.
  const pricedAll = all.filter(priced), pricedSubs = subs.filter(a => agentInputCost(a) != null);  // delegation savings need input cost
  const advCost = s.adv.paid.total > 0 && !local(advModel) ? s.adv.paid.total : cost(advModel, s.adv.u);  // reported cost first, as for agents
  const unpriced = [...new Set(all.filter(a => !priced(a)).map(a => a.model).concat(s.adv.calls && advCost == null ? advModel : []).filter(Boolean))];
  return {
    main, subs, mainModel, advModel, unpriced, partial: unpriced.length > 0, readSubs: pricedSubs, unpricedSubs: subs.length - pricedSubs.length,
    models: [...new Set(all.map(a => a.model).concat(advModel ?? []).filter(Boolean).map(baseModel))],
    advCost,
    cost: sum(pricedAll, agentCost) + (advCost ?? 0),
    costIfMain: mainPriced ? sum(pricedAll, a => cost(mainModel, a.u)) + (advCost != null ? cost(mainModel, s.adv.u) : 0) : null,
    readTokens: sum(pricedSubs, a => readTokens(a.u)),
    readCost: sum(pricedSubs, agentInputCost),
    readCostIfMain: mainPriced ? sum(pricedSubs, a => inputCost(mainModel, a.u)) : null,
  };
}
