import { chromium } from 'playwright';
import { BASE } from './lib.mjs';
import { tmpdir } from 'node:os';
const SC = process.argv[2] || tmpdir();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + m + (c ? '' : ' ' + x)); };
const settle = ms => page.waitForTimeout(ms ?? 700);

// pretend OPFS dir is "a folder on disk" chosen through the real picker code path
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('real-vault', { create: true });
});
await page.goto(BASE);
const OBS = `---
title: "Quarterly: review"
tags: [work, review]
aliases:
  - QR
nested:
  a: 1
---

# Quarterly review

Intro paragraph with **bold** and a [[Linked Note|alias]].

## Agenda
- Item one
\t- tabbed child
\t\t- grandchild
- [ ] open task
- [x] done task
1. first
2. second

| col a | col b |
|-------|-------|
| 1     | 2     |

\`\`\`js
const a = 1;

console.log(a);
\`\`\`

> quote line
`;
await page.evaluate(async obs => {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle('real-vault', { create: true });
  const w = async (path, text) => { let dir = d; const parts = path.split('/'); const n = parts.pop(); for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true }); const wr = await (await dir.getFileHandle(n, { create: true })).createWritable(); await wr.write(text); await wr.close(); };
  await w('Quarterly review.md', obs);
  await w('Linked Note.md', '- hello\n');
  await w('.obsidian/app.json', '{}');
  await w('node_modules/x.md', '- ignore me\n');
}, OBS);
const read = path => page.evaluate(async path => { const root = await navigator.storage.getDirectory(); let d = await root.getDirectoryHandle('real-vault'); const parts = path.split('/'); const n = parts.pop(); for (const p of parts) d = await d.getDirectoryHandle(p); const f = await (await d.getFileHandle(n)).getFile(); return { text: await f.text(), mtime: f.lastModified }; }, path);

console.log('# open folder through the picker path');
await page.click('text=Open a folder');
await page.waitForSelector('.sidebar .side-item.file');
const files = await page.$$eval('.side-item.file .si-name', e => e.map(x => x.textContent).sort());
ok(JSON.stringify(files) === JSON.stringify(['Linked Note', 'Quarterly review']), 'scans only visible .md files', files.join());
await page.evaluate(() => hermes.go({ path: 'Quarterly review.md' }));
await page.waitForSelector('.page-title');
await page.screenshot({ path: SC + '/10-obsidian-note.png' });
const before = await read('Quarterly review.md');
// focus around without editing
for (const t of ['Item one', 'open task', 'done task']) { await page.click(`.row .view:has-text("${t}")`, { position: { x: 5, y: 5 } }); await page.keyboard.press('Escape'); }
await settle(900);
const afterView = await read('Quarterly review.md');
ok(afterView.mtime === before.mtime, 'focusing rows does not rewrite the file');

console.log('# lossless edit');
await page.click('.row .view:has-text("grandchild")', { position: { x: 5, y: 5 } });
await page.keyboard.press('End');
await page.keyboard.type(' edited');
await settle(900);
const edited = await read('Quarterly review.md');
const expected = before.text.replace('\t\t- grandchild', '\t\t- grandchild edited');
ok(edited.text === expected, 'only the edited line changes (tabs, YAML, table, code, CRLF-safe)', JSON.stringify(edited.text.slice(0, 400)));

console.log('# structure ops');
await page.click('.row .view:has-text("open task")', { position: { x: 5, y: 5 } });
await page.keyboard.press('Alt+ArrowUp');
await settle(700);
let t = (await read('Quarterly review.md')).text;
ok(/- \[ \] open task\n- Item one/.test(t), 'Alt+Up moves a node above its sibling', t.slice(150, 400));
await page.keyboard.press('Alt+ArrowDown');
await settle(300);
await page.keyboard.press('Tab');
await settle(700);
t = (await read('Quarterly review.md')).text;
ok(/- Item one\n(\t|  )- tabbed child\n(\t\t|    )- grandchild edited\n(\t|  )- \[ \] open task/.test(t), 'Tab indents under previous sibling, file keeps its tab style', JSON.stringify(t.slice(150, 400)));
await page.keyboard.press('Shift+Tab');
await settle(500);
// collapse
await page.click('.row .view:has-text("Item one")', { position: { x: 5, y: 5 } });
await page.keyboard.press('Control+ArrowUp');
await settle(300);
ok(await page.$$eval('.row .view', e => !e.some(x => x.textContent.includes('tabbed child'))), 'Ctrl+Up collapses children');
await page.keyboard.press('Control+ArrowDown');
await settle(300);
ok(await page.$$eval('.row .view', e => e.some(x => x.textContent.includes('tabbed child'))), 'Ctrl+Down expands');
// zoom
await page.click('.row:has(.view:has-text("tabbed child")) .bullet');
await settle(400);
ok(page.url().includes('?z='), 'bullet click zooms into node');
await page.screenshot({ path: SC + '/11-zoom.png' });
await page.goBack();
await settle(400);
// merge up with Backspace
await page.click('.row .view:has-text("second")', { position: { x: 5, y: 5 } });
await page.keyboard.press('Home');
await page.keyboard.press('Backspace');
await settle(700);
t = (await read('Quarterly review.md')).text;
ok(/1\. firstsecond/.test(t), 'Backspace at start merges into previous bullet', JSON.stringify(t.slice(300, 500)));
await page.keyboard.press('Control+z');
await settle(700);
t = (await read('Quarterly review.md')).text;
ok(/1\. first\n2\. second/.test(t), 'Undo restores split bullets');

console.log('# drag and drop reorder');
await page.evaluate(() => hermes.go({ path: 'Quarterly review.md' }));
const src = page.locator('.row:has(.view:has-text("done task")) .bullet');
const dst = page.locator('.row:has(.view:has-text("Item one"))');
const box = await dst.boundingBox();
await src.dragTo(dst, { targetPosition: { x: 80, y: 2 } });
await settle(800);
t = (await read('Quarterly review.md')).text;
ok(/- \[x\] done task\n- Item one/.test(t), 'dragging a bullet above another reorders in the file', JSON.stringify(t.slice(150, 450)));

console.log('# reload restores vault + route');
await page.reload();
await page.waitForSelector('.sidebar .side-item.file', { timeout: 10000 });
await page.waitForSelector('.page-title');
ok((await page.inputValue('.page-title')) === 'Quarterly review', 'auto-reopens last folder and route');

console.log('# theme + narrow screen');
await page.click('[title="Toggle theme"]');
await settle(300);
await page.evaluate(() => hermes.go({ db: true, tag: 'work' }));
await settle(500);
await page.screenshot({ path: SC + '/12-dark-db.png' });
await page.evaluate(() => hermes.go({ path: 'Quarterly review.md' }));
await settle(300);
await page.screenshot({ path: SC + '/13-dark-page.png' });
await page.setViewportSize({ width: 390, height: 800 });
await settle(400);
await page.evaluate(() => hermes.toggleSidebar(false));
await page.screenshot({ path: SC + '/14-mobile.png' });

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
