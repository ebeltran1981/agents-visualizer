import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf, setLocalPrices } from '../aggregate.js';

test('a known family is found anywhere in the name, whatever the gateway wraps around it', () => {
  const opus = colorOf('claude-opus-5-5');
  for (const m of ['us.anthropic.claude-opus-5-5-v1:0', 'global.anthropic.claude-opus-5-5-v1:0', 'opus']) assert.equal(colorOf(m), opus);
  assert.equal(colorOf('moonshot.kimi-k3.1-pro'), colorOf('kimi-k3.1-pro:cloud'));
  assert.equal(colorOf('openai.gpt-5.2'), colorOf('gpt-5-mini'));
  assert.equal(colorOf('us.amazon.nova-pro-v1:0'), colorOf('nova-lite'));
});

test('families have different colours, none of them the red kept for errors', () => {
  const colors = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'gpt-5', 'kimi-k3', 'deepseek-v4-pro', 'glm-5.3', 'nova-pro', 'qwen3.5', 'minimax-m3', 'llama-4'].map(colorOf);
  assert.equal(new Set(colors).size, colors.length);
  assert.ok(!colors.includes('#f36a6a'));
});

test('an unknown model still gets a colour, the same one every time', () => {
  const c = colorOf('acme-turbo-9');
  assert.match(c, /^#[0-9a-f]{6}$/);
  assert.equal(colorOf('acme-turbo-9'), c);
});

test('prices.local.json can set the colour, and its family name is matched too', () => {
  setLocalPrices({ 'company-large': { in: 3, out: 15, color: '#123456' }, 'company-small': { in: 1, out: 2, family: 'our sonnet' } });
  assert.equal(colorOf('company-large'), '#123456');
  assert.equal(colorOf('company-small'), colorOf('claude-sonnet-5-5'));
  setLocalPrices({});
});

test('no model, no colour', () => assert.equal(colorOf(''), ''));
