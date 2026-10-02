import { chromium } from 'playwright';
import { BASE } from './lib.mjs';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('big-vault', { create: true }); });
await page.goto(BASE);
const N = 3000;
let t0 = Date.now();
await page.evaluate(async N => {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle('big-vault', { create: true });
  const statuses = ['Todo', 'In progress', 'Done', 'Blocked'];
  for (let f = 0; f < 30; f++) {
    const dir = await d.getDirectoryHandle('folder' + f, { create: true });
    await Promise.all(Array.from({ length: N / 30 }, async (_, i) => {
      const id = f * (N / 30) + i;
      let s = `---\ntags: [${id % 3 === 0 ? 'project' : 'note'}]\nstatus: ${statuses[id % 4]}\n---\n- Note ${id} intro with [[Note ${(id + 1) % N}]]\n`;
      for (let k = 0; k < 12; k++) {
        s += `  - [ ] Task ${id}.${k} about something #task\n    - status:: ${statuses[(id + k) % 4]}\n    - effort:: ${k}\n    - due:: 2026-10-${String(1 + (k % 28)).padStart(2, '0')}\n`;
      }
      const w = await (await dir.getFileHandle(`Note ${id}.md`, { create: true })).createWritable();
      await w.write(s); await w.close();
    }));
  }
}, N);
console.log('seed ms', Date.now() - t0);
t0 = Date.now();
await page.click('text=Open a folder');
await page.waitForSelector('.sidebar .side-item', { timeout: 120000 });
console.log('cold open (3000 files, ~', N * 49, 'bullets) ms', Date.now() - t0);
await page.reload();
t0 = Date.now();
await page.waitForSelector('.sidebar .side-item', { timeout: 120000 });
console.log('warm open (IndexedDB cache) ms', Date.now() - t0);
t0 = Date.now();
await page.evaluate(() => hermes.go({ db: true, tag: 'task' }));
await page.waitForSelector('table.grid');
console.log('task table, records:', await page.textContent('.db-count'), 'render ms', Date.now() - t0);
t0 = Date.now();
await page.fill('.tool-search', 'Task 1500.7');
await page.waitForFunction(() => document.querySelectorAll('tr.rec').length === 1);
console.log('search 36k records ms', Date.now() - t0);
// poll cost
const pollMs = await page.evaluate(async () => { const t = performance.now(); await hermes.vault.poll(); return performance.now() - t; });
console.log('one poll over 3000 files ms', Math.round(pollMs));
// typing latency on a page
await page.evaluate(() => hermes.go({ path: 'folder3/Note 100.md' }));
await page.waitForSelector('.row');
await page.click('.row .view >> nth=0', { position: { x: 5, y: 5 } });
const lat = await page.evaluate(async () => {
  const ta = document.activeElement; const times = [];
  for (let i = 0; i < 40; i++) { const t = performance.now(); ta.value += 'x'; ta.dispatchEvent(new Event('input', { bubbles: true })); times.push(performance.now() - t); }
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, max: Math.max(...times) };
});
console.log('keystroke handler avg/max ms', lat.avg.toFixed(2), lat.max.toFixed(2));
const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
console.log('JS heap MB', mem);
console.log('errors', errors);
await browser.close();
