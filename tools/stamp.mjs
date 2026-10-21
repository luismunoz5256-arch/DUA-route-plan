// Gives every script and stylesheet a version tag (a hash of its contents) in index.html and
// driver.html, so browsers fetch a file again exactly when it changed and never mix old and new
// files after an update. Run after changing anything in js/ or css/:
//   node tools/stamp.mjs           update the pages
//   node tools/stamp.mjs --check   fail if they are out of date (used by the tests)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

export function versions() {
  const v = {};
  for (const dir of ['js', 'css']) for (const f of readdirSync(join(root, dir)).sort()) v[`${dir}/${f}`] = hash(read(`${dir}/${f}`));
  // The optimizer worker loads solver.js with its own version tag, so it covers both files.
  v['js/solver-worker.js'] = hash(read('js/solver-worker.js') + read('js/solver.js'));
  return v;
}

export function stampPage(html, v) {
  const imports = Object.fromEntries(Object.keys(v).filter((p) => p.endsWith('.js')).map((p) => [`./${p}`, `./${p}?v=${v[p]}`]));
  const build = hash(JSON.stringify(v));
  return html
    .replace(/(href|src)="((?:css|js)\/[\w-]+\.(?:css|js))(?:\?v=\w+)?"/g, (m, attr, path) => (v[path] ? `${attr}="${path}?v=${v[path]}"` : m))
    .replace(/\n *<script type="importmap">[\s\S]*?<\/script>/, '')
    .replace(/( *)(<script type="module")/, `$1<script type="importmap">${JSON.stringify({ imports })}</script>\n$1$2`)
    .replace(/<meta name="build" content="\w*" \/>/, `<meta name="build" content="${build}" />`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = versions();
  let stale = [];
  for (const page of ['index.html', 'driver.html']) {
    const before = read(page);
    const after = stampPage(before, v);
    if (after === before) continue;
    if (process.argv.includes('--check')) stale.push(page);
    else writeFileSync(join(root, page), after);
  }
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run: node tools/stamp.mjs`);
    process.exit(1);
  }
}
