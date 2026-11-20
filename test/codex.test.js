import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slim } from '../harnesses/codex.js';

const ts = '2026-11-20T21:50:00.000Z';
const item = payload => ({ timestamp: ts, type: 'response_item', payload });
const call = (name, args, call_id = 'c1') => item({ type: 'function_call', name, call_id, arguments: JSON.stringify(args) });
const usage = (response_id, u) => ({ timestamp: ts, type: 'token_usage_record', payload: { response_id, usage: u } });
const run = records => { const ctx = { calls: [], text: '', started: true, model: 'm' }; return records.map(r => slim(r, ctx)).filter(Boolean); };

test('a response is its calls and text, emitted once with the usage record that follows them', () => {
  const [a] = run([
    call('exec_command', { cmd: 'node --test' }),
    usage('resp_1', { input_tokens: 1000, cached_input_tokens: 700, cache_write_input_tokens: 100, output_tokens: 50 }),
  ]);
  assert.equal(a.id, 'resp_1');
  assert.deepEqual(a.u, { in: 200, out: 50, cr: 700, cw: 100, cw1h: 0 });  // input_tokens includes the cached ones
  assert.deepEqual(a.tools.map(t => [t.name, t.input]), [['bash', 'node --test']]);
});

test('commands are named by what they do', () => {
  const [a] = run([
    call('exec_command', { cmd: "sed -n '1,240p' SPEC.md" }),
    call('exec_command', { cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: PLAN.md\n+x\n*** End Patch\nPATCH" }),
    call('exec_command', { cmd: "mkdir -p src\ncat > src/slugify.js <<'EOF'\nexport {}\nEOF" }),
    call('spawn_agent', { message: 'Build slugify' }),
    usage('r', {}),
  ]);
  assert.deepEqual(a.tools.map(t => [t.name, t.input, t.file]),
    [['read', 'SPEC.md', 'SPEC.md'], ['edit', 'PLAN.md', 'PLAN.md'], ['edit', 'src/slugify.js', 'src/slugify.js'], ['agent', 'Build slugify', undefined]]);
});

test('the final message carries its text and verdict; codex context messages are not prompts', () => {
  const out = run([
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n…' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All good.\nPASS' }] }),
    usage('r', {}),
  ]);
  assert.deepEqual(out.map(r => [r.t, r.text, r.verdict]), [['p', 'hello', undefined], ['a', 'All good.\nPASS', 'PASS']]);
});

test('a failed command or an unsupported call is an error result', () => {
  const out = run([
    item({ type: 'function_call_output', output: 'Chunk ID: 1\nProcess exited with code 0\nOutput:\nerror in a log line' }),
    item({ type: 'function_call_output', output: 'Chunk ID: 2\nProcess exited with code 1\nOutput:\nboom' }),
    item({ type: 'function_call_output', output: 'unsupported call: multi_agent_v1' }),
  ]);
  assert.deepEqual(out.map(r => r.results[0].err), [false, true, true]);
});

test("a subagent's file replays its parent's messages first; they are skipped", () => {
  const ctx = { calls: [], text: '', model: 'm' };
  const records = [
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: "the parent's prompt" }] }),
    { timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'your task' }] }),
  ];
  assert.deepEqual(records.map(r => slim(r, ctx)).filter(Boolean).map(r => r.text), ['your task']);
});
