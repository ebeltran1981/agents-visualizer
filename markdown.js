// A small Markdown renderer for agent messages, no dependencies. It covers what agents write: fenced code,
// headings, tables, lists with one nested level, horizontal rules, paragraphs, `code`, **bold** and *italic*.
// Everything is HTML-escaped first, so the output holds only the tags made here.

const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const indentOf = line => line.match(/^ */)[0].length;

const FENCE = /^ *```/;
const HEADING = /^(#{1,6}) +(.*)$/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const ITEM = /^( *)([-*+]|(\d+)[.)]) +(.*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

const isTable = (lines, i) => lines[i].includes('|') && lines[i + 1]?.includes('|') && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i);

// `code` spans are cut out first, so nothing inside them is parsed. Line breaks are kept.
function inline(s) {
  const codes = [];
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `\0${codes.push(c) - 1}\0`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/\0(\d+)\0/g, (_, i) => `<code>${codes[i]}</code>`)
    .replace(/\n/g, '<br>');
}

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));

const listHtml = items => {
  const { ordered, start } = items[0], tag = ordered ? 'ol' : 'ul';
  const lis = items.map(it => `<li>${inline(it.text)}${it.kids.length ? listHtml(it.kids) : ''}</li>`).join('');
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${lis}</${tag}>`;
};

// Items at the first item's indent make the list; items indented further nest under the item above,
// and indented lines that aren't items continue the item above. Returns the HTML and the next line.
function list(lines, i) {
  const top = [], base = indentOf(lines[i]);
  for (; i < lines.length; i++) {
    const m = lines[i].match(ITEM), indent = indentOf(lines[i]);
    if (m) {
      const item = { ordered: !!m[3], start: +m[3], text: m[4], kids: [] };
      if (indent > base + 1 && top.length) top.at(-1).kids.push(item); else top.push(item);
    } else if (lines[i].trim() && indent > base) {
      const parent = top.at(-1);
      (parent.kids.at(-1) ?? parent).text += '\n' + lines[i].trim();
    } else break;
  }
  return [listHtml(top), i];
}

export function markdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code = [];
      while (++i < lines.length && !FENCE.test(lines[i])) code.push(lines[i]);
      i++;  // past the closing fence
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (HEADING.test(line)) {
      const [, hashes, title] = line.match(HEADING), h = `h${hashes.length}`;
      out.push(`<${h}>${inline(title)}</${h}>`);
      i++;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (isTable(lines, i)) {
      const head = cells(lines[i]).map(c => `<th>${c}</th>`).join(''), rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|'); i++) rows.push(`<tr>${cells(lines[i]).map(c => `<td>${c}</td>`).join('')}</tr>`);
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
    } else if (ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      do para.push(lines[i++]); while (i < lines.length && lines[i].trim() && !startsBlock(lines, i));
      out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
  }
  return out.join('');
}
