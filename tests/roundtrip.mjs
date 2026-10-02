// Pure-Node checks for the markdown model: lossless round trips and safe rendering.
import assert from 'node:assert/strict';
import { parsePage, serializePage, renderInline, extractTags, parseField, fmSet } from '../src/md.js';

const samples = {
  obsidian: `---
tags:
  - project
  - work
status: Active
due: 2026-10-10
title: "A: B"
nested:
  a: 1
---

# Heading one

Some paragraph text
with second line.

- bullet one #task
\t- child [[Page|alias]]
\t\t- deeper
- [ ] todo item
- [x] done item
  continuation line
1. numbered
2. second

## Sub heading
\`\`\`js
const x = 1;

console.log(x);
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

- status:: Active
`,
  spaces: '- a\n  - b\n    - c\n- d\n',
  noNewline: 'no trailing newline',
  crlf: '---\r\ntags: [a, b]\r\n---\r\n- x\r\n',
  bom: '﻿---\ntags: [a]\n---\n- x\n',
  empty: '',
};
for (const [name, src] of Object.entries(samples)) {
  const want = src === '' || src.endsWith('\n') ? src : src + '\n';
  assert.equal(serializePage(parsePage(src)), want, `round trip: ${name}`);
}

const p = parsePage(samples.obsidian);
assert.deepEqual(p.fm.entries.find(e => e.key === 'tags').value, ['project', 'work']);
assert.equal(p.fm.entries.find(e => e.key === 'nested').complex, true);
assert.equal(p.nodes[0].kind, 'heading');
fmSet(p, 'status', 'On hold: soon');
const out = serializePage(p);
assert.match(out, /^status: "On hold: soon"$/m);
assert.match(out, /^nested:\n  a: 1$/m, 'untouched YAML is preserved verbatim');

assert.deepEqual(extractTags('x #a #b/c `#no` [[#no]] 2026 #123 #a-1'), ['a', 'b/c', 'a-1']);
assert.deepEqual(parseField({ kind: 'bullet', text: 'due:: 2026-10-10' }), { key: 'due', value: '2026-10-10' });
assert.equal(parseField({ kind: 'bullet', text: 'http://x::y' }), null);

const html = renderInline('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [[x" onclick="y]]', { resolve: () => true });
assert.ok(!/<img|<script/i.test(html) && !/href="javascript/i.test(html), 'renderer escapes HTML and blocks javascript: URLs');

console.log('roundtrip: all checks passed');
