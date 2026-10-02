import { start, readFile, writeFile } from './lib.mjs';
import { tmpdir } from 'node:os';
const SC = process.argv[2] || tmpdir();
const { browser, page, errors } = await start();
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + ' ' + extra); } };
const settle = ms => page.waitForTimeout(ms ?? 700);
const focused = () => page.evaluate(() => document.activeElement?.value ?? null);

console.log('# outline editing');
await page.click('.row .view:has-text("search and jump")', { position: { x: 5, y: 5 } });
await page.keyboard.press('End');
ok((await focused())?.includes('toggle sidebar'), 'click enters edit mode on the row');
await page.keyboard.press('Enter');
await page.keyboard.type('Brand new bullet');
await page.keyboard.press('Tab');
await settle();
let md = await readFile(page, 'Welcome.md');
ok(/^ {4}- Brand new bullet$/m.test(md), 'Enter + Tab writes a nested bullet to the md file', md.slice(-300));
await page.keyboard.press('Control+z');
await settle(400);
md = await readFile(page, 'Welcome.md');
ok(/^ {2}- Brand new bullet$/m.test(md), 'Undo reverts the indent', md.slice(-200));
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
await settle(500);
md = await readFile(page, 'Welcome.md');
ok(!md.includes('Brand new bullet'), 'Undo x3 removes the bullet entirely');
await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z');
await settle(500);
md = await readFile(page, 'Welcome.md');
ok(/^ {2}- Brand new bullet$/m.test(md), 'Redo x2 restores the typed bullet', md.slice(-200));

console.log('# suggestions');
await page.keyboard.press('End');
await page.keyboard.type(' #ta');
await page.waitForSelector('.suggest');
const sug = await page.$$eval('.sg-item .sg-label', e => e.map(x => x.textContent));
ok(sug.includes('#task'), 'typing # shows tag suggestions', sug.join());
await page.keyboard.press('Enter');
ok((await focused()).includes('#task '), 'Enter accepts tag suggestion', await focused());
await page.keyboard.type('and [[Ada');
await page.waitForSelector('.suggest');
await page.keyboard.press('Enter');
ok((await focused()).includes('[[Ada Lovelace]]'), 'wikilink suggestion completes', await focused());
await page.keyboard.press('Escape');
await settle(900);
md = await readFile(page, 'Welcome.md');
ok(md.includes('#task and [[Ada Lovelace]]'), 'tag + link persisted', md.slice(-250));

console.log('# slash + task shortcuts');
await page.keyboard.press('Control+End'); // noop
await page.click('.row .view:has-text("Ctrl/Cmd+Z undoes")', { position: { x: 5, y: 5 } });
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('[] buy milk');
await settle(800);
md = await readFile(page, 'Welcome.md');
ok(/- \[ \] buy milk/.test(md), '"[] " converts to a task', md.slice(-300));
await page.keyboard.press('Control+Enter');
await settle(800);
md = await readFile(page, 'Welcome.md');
ok(/- \[x\] buy milk/.test(md), 'Ctrl+Enter checks the task');

console.log('# paste outline');
await page.keyboard.press('Enter');
await page.evaluate(() => {
  const ta = document.activeElement;
  const dt = new DataTransfer();
  dt.setData('text/plain', '- pasted A\n  - pasted A1\n- pasted B\n');
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await settle(900);
md = await readFile(page, 'Welcome.md');
ok(/ - pasted A\n.* - pasted A1\n.* - pasted B/.test(md), 'pasting markdown creates nodes', md.slice(-250));

console.log('# database');
await page.click('.side-item[data-db="task"]');
await page.waitForSelector('table.grid');
const rows = await page.$$eval('tr.rec', e => e.length);
ok(rows >= 24, `task table has records (${rows})`);
// edit status of "Write launch announcement"
const row = page.locator('tr.rec', { hasText: 'Write launch announcement' });
await row.locator('td[data-key="status"]').click();
await page.click('.menu-item:has-text("Done")');
await settle(900);
md = await readFile(page, 'Projects/Hermes Launch.md');
ok(/\[x\] Write launch announcement #task\n\s+- status:: Done/.test(md), 'status cell edit writes field AND checks the task', md);
// edit title
await row.locator('td[data-key="@title"]').click();
await page.keyboard.press('Control+a');
await page.keyboard.type('Write the launch post');
await page.keyboard.press('Enter');
await settle(900);
md = await readFile(page, 'Projects/Hermes Launch.md');
ok(md.includes('Write the launch post #task'), 'title edit keeps the tag', md);
// number edit
await page.locator('tr.rec', { hasText: 'Write the launch post' }).locator('td[data-key="effort"]').click();
await page.keyboard.press('Control+a');
await page.keyboard.type('13');
await page.keyboard.press('Enter');
await settle(900);
md = await readFile(page, 'Projects/Hermes Launch.md');
ok(/effort:: 13/.test(md), 'number cell edit persists');
// filter
await page.click('.tool:has-text("Filter")');
await page.click('.btn:has-text("Add filter")');
await settle(300);
const countTxt = await page.textContent('.db-count');
ok(/records/.test(countTxt), 'filter added: ' + countTxt);
await page.screenshot({ path: SC + '/05-filter.png' });
await page.keyboard.press('Escape');
await page.click('.tool:has-text("Filter")');
await page.click('.frow .icon-btn');
await page.keyboard.press('Escape');
// group
await page.click('.tool:has-text("Group")');
await page.click('.menu-item:has-text("status")');
await settle(400);
const groups = await page.$$eval('.group-row .group-label', e => e.map(x => x.textContent));
ok(groups.length >= 3, 'group by status: ' + groups.join());
await page.screenshot({ path: SC + '/06-grouped.png' });
// project (page records) database
await page.click('.side-item[data-db="project"]');
await page.waitForSelector('table.grid');
await page.locator('tr.rec', { hasText: 'Mobile App v2' }).locator('td[data-key="status"]').click();
await page.click('.menu-item:has-text("Active")');
await settle(900);
md = await readFile(page, 'Projects/Mobile App v2.md');
ok(/^status: Active$/m.test(md), 'frontmatter record edit writes YAML', md.slice(0, 200));
ok(/^owner: "\[\[Alan Turing\]\]"$/m.test(md), 'untouched frontmatter preserved byte-for-byte', md.slice(0, 200));
await page.screenshot({ path: SC + '/07-projects.png' });

console.log('# board drag');
await page.click('.side-item[data-db="task"]');
await page.waitForSelector('table.grid');
await page.click('.tab.add'); await page.click('.menu-item:has-text("Board")');
await page.waitForSelector('.board');
const card = page.locator('.card', { hasText: 'Finalize pricing page' });
await card.dragTo(page.locator('.bcol[data-key="In progress"] .bcards'));
await settle(900);
md = await readFile(page, 'Projects/Hermes Launch.md');
ok(/Finalize pricing page #task\n\s+- status:: In progress/.test(md), 'dragging a card updates the field in markdown', md.slice(-900));

console.log('# live sync from disk');
await page.click('.side-item[data-path="Welcome.md"]');
await page.waitForSelector('.row');
let md2 = await readFile(page, 'Welcome.md');
await writeFile(page, 'Welcome.md', md2.replace('# placeholder', '') + '- Added from outside the app #idea\n');
await page.waitForSelector('.view:has-text("Added from outside the app")', { timeout: 8000 }).then(() => ok(true, 'external file edit shows up in the open page'), () => ok(false, 'external edit not picked up'));
await writeFile(page, 'Brand New External.md', '---\ntags: [project]\nstatus: Planning\n---\n- hello\n');
await page.waitForSelector('.side-item[data-path="Brand New External.md"]', { timeout: 8000 }).then(() => ok(true, 'new external file appears in sidebar'), () => ok(false, 'new file not detected'));

console.log('# rename updates links');
await page.evaluate(() => hermes.go({ path: 'People/Ada Lovelace.md' }));
await page.waitForSelector('.page-title');
await page.fill('.page-title', 'Ada L');
await page.keyboard.press('Enter');
await settle(1500);
const mdRel = await readFile(page, 'Projects/Hermes Launch.md');
ok(mdRel.includes('"[[Ada L]]"') || mdRel.includes('[[Ada L]]'), 'rename rewrites [[links]] in other files', mdRel.slice(0, 200));

console.log('# today + palette');
await page.keyboard.press('Alt+d');
await page.waitForSelector('.page-title');
const t = await page.inputValue('.page-title');
ok(/^\d{4}-\d{2}-\d{2}$/.test(t), 'Alt+D opens daily note ' + t);
await page.keyboard.press('Control+k');
await page.keyboard.type('pricing');
await page.waitForSelector('.palette-item');
await page.screenshot({ path: SC + '/08-palette.png' });
await page.keyboard.press('Enter');
await settle(500);
ok(/Hermes%20Launch|Hermes Launch/.test(decodeURIComponent(page.url())), 'palette jumps to a bullet in its page ' + decodeURIComponent(page.url()));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
