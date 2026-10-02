// Starts a static server, runs the unit check and every browser test, prints a summary.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 8321);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('not found'); }
}).listen(port);

const env = { ...process.env, BASE: `http://localhost:${port}/` };
const suites = ['roundtrip.mjs', 'outline-and-database.mjs', 'real-folder.mjs', 'records-and-vaults.mjs'];
if (process.env.PERF) suites.push('perf.mjs');
const run = file => new Promise(resolve => {
  const child = spawn('node', [join(root, 'tests', file)], { stdio: ['ignore', 'pipe', 'inherit'], env });
  let out = '';
  child.stdout.on('data', d => { out += d; process.stdout.write(d); });
  child.on('close', code => resolve(code !== 0 || /FAIL/.test(out) || /ERRORS: (?!none)/.test(out)));
});
let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s}`);
  if (await run(s)) failed++;
}
server.close();
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
