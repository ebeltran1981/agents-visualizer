import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../markdown.js';

test('HTML in a message is shown as text, never run', () => {
  const html = markdown('<script>alert(1)</script> and <b onclick="x">hi</b>');
  assert.ok(!/<script|<b /.test(html));
  assert.equal(html, '<p>&#60;script&#62;alert(1)&#60;/script&#62; and &#60;b onclick=&#34;x&#34;&#62;hi&#60;/b&#62;</p>');
});

test('fenced code is kept as typed, with nothing inside it parsed', () => {
  assert.equal(markdown("```js\nconst a = '<b>**x**</b>';\n  # not a heading\n```"),
    "<pre><code>const a = '&#60;b&#62;**x**&#60;/b&#62;';\n  # not a heading</code></pre>");
});

test('an unclosed fence runs to the end', () => {
  assert.equal(markdown('```\nline 1\nline 2'), '<pre><code>line 1\nline 2</code></pre>');
});

test('inline code, bold and italic', () => {
  assert.equal(markdown('use `a**b**` with **bold** and *it*'), '<p>use <code>a**b**</code> with <b>bold</b> and <i>it</i></p>');
});

test('snake_case names and lone asterisks stay as typed', () => {
  assert.equal(markdown('my_var_name in file_path, 2 * 3 * 4'), '<p>my_var_name in file_path, 2 * 3 * 4</p>');
});

test('headings and horizontal rules', () => {
  assert.equal(markdown('## Title with `code`\n\n---\n\ntext'), '<h2>Title with <code>code</code></h2><hr><p>text</p>');
});

test('paragraphs keep their line breaks', () => {
  assert.equal(markdown('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
});

test('GFM tables', () => {
  assert.equal(markdown('| a | b |\n|---|:-:|\n| `x` | **y** |\n| 1 | 2 |'),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x</code></td><td><b>y</b></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
});

test('bullet lists with one nested level', () => {
  assert.equal(markdown('- one\n  - nested\n- two'), '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>');
});

test('numbered lists keep their start number and continuation lines', () => {
  assert.equal(markdown('3. **A**\n   more about A\n4. B'), '<ol start="3"><li><b>A</b><br>more about A</li><li>B</li></ol>');
});

test('a list right after a paragraph line starts a list', () => {
  assert.equal(markdown('Changes:\n- one\n- two\n\nDone.'), '<p>Changes:</p><ul><li>one</li><li>two</li></ul><p>Done.</p>');
});
