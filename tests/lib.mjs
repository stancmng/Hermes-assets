import { chromium } from 'playwright';

export const BASE = process.env.BASE || 'http://localhost:8321/';
export async function start(opts = {}) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (['error'].includes(m.type())) errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '')));
  await page.goto(BASE);
  await page.click('text=Try the demo vault');
  await page.waitForSelector('.sidebar .side-item.file', { timeout: 10000 });
  return { browser, ctx, page, errors };
}
export const readFile = (page, path) => page.evaluate(async path => {
  const root = await navigator.storage.getDirectory();
  let d = await root.getDirectoryHandle('hermes-demo');
  const parts = path.split('/'); const name = parts.pop();
  for (const p of parts) d = await d.getDirectoryHandle(p);
  return (await (await d.getFileHandle(name)).getFile()).text();
}, path);
export const writeFile = (page, path, text) => page.evaluate(async ([path, text]) => {
  const root = await navigator.storage.getDirectory();
  let d = await root.getDirectoryHandle('hermes-demo');
  const parts = path.split('/'); const name = parts.pop();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(text); await w.close();
}, [path, text]);
