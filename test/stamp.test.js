import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { versions, stampPage } from '../tools/stamp.mjs';

test('pages carry the current version of every script and stylesheet (run: node tools/stamp.mjs)', () => {
  const v = versions();
  for (const page of ['index.html', 'driver.html']) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.equal(html, stampPage(html, v), `${page} is out of date`);
  }
});

test('stamping tags local files, maps module imports and leaves other links alone', () => {
  const html = '<link href="css/a.css" /><link href="vendor/x.css" />\n    <script type="module" src="js/app.js"></script><meta name="build" content="" />';
  const out = stampPage(html, { 'css/a.css': 'aaaa1111', 'js/app.js': 'bbbb2222', 'js/util.js': 'cccc3333' });
  assert.match(out, /href="css\/a\.css\?v=aaaa1111"/);
  assert.match(out, /href="vendor\/x\.css"/);
  assert.match(out, /src="js\/app\.js\?v=bbbb2222"/);
  assert.match(out, /"\.\/js\/util\.js":"\.\/js\/util\.js\?v=cccc3333"/);
  assert.match(out, /<meta name="build" content="\w{8}" \/>/);
  assert.equal(stampPage(out, { 'css/a.css': 'aaaa1111', 'js/app.js': 'bbbb2222', 'js/util.js': 'cccc3333' }), out, 'stamping twice changes nothing');
});
