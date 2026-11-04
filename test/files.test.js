import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cwdOf, tail } from '../harnesses/common.js';

// A directory opened as a file opens fine on Linux, then the read throws EISDIR: a real failure mid-read.
const linux = fs.existsSync('/proc/self/fd');
const openFiles = () => fs.readdirSync('/proc/self/fd').length;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-test-'));
fs.writeFileSync(path.join(dir, 'f'), 'x');  // so the directory's size isn't 0 and tail tries to read it
after(() => fs.rmSync(dir, { recursive: true }));

test('cwdOf closes the file when the read fails', { skip: !linux }, () => {
  const before = openFiles();
  assert.throws(() => cwdOf(dir), /EISDIR/);
  assert.equal(openFiles(), before);
});

test('tail closes the file when the read fails', { skip: !linux }, () => {
  const before = openFiles();
  assert.throws(() => tail(dir, () => {}, () => {})(), /EISDIR/);
  assert.equal(openFiles(), before);
});

test('cwdOf reads an escaped Windows path', () => {
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\proj' }) + '\n');
  assert.equal(cwdOf(file), 'C:\\Users\\me\\proj');
});
