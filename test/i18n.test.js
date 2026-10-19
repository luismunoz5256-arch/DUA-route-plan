import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ES } from '../js/es.js';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Text that is the same in both languages, or not shown to people.
const SAME = new Set(['DUA Route Planner', 'W', 'Google Maps', 'h', 'min', 'mi', 'name, address, days, unload, earliest, latest, notes', 'Mon Wed Fri', 'Mon-Sat', 'daily', 'https://script.google.com/macros/s/…/exec', 'Total']);

function englishTexts() {
  const keys = new Set();
  for (const f of fs.readdirSync(path.join(root, 'js'))) {
    if (!f.endsWith('.js') || f === 'es.js') continue;
    const src = read(`js/${f}`);
    // t('…'), t("…"), plural(n, '…', '…')
    const re = /\b(?:t|plural)\(\s*(?:[\w.]+\s*,\s*)?(['"`])((?:\\.|(?!\1).)*)\1(?:\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3)?/g;
    for (const m of src.matchAll(re)) {
      for (const k of [m[2], m[4]]) if (k && !k.includes('${')) keys.add(k.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n'));
    }
    // table headers written as ['A', 'B', …].map((h) => … t(h))
    for (const m of src.matchAll(/\[((?:'[^']*',\s*)+'[^']*')\]\.map\(\(h\) =>/g)) for (const k of m[1].match(/'([^']*)'/g)) if (k.length > 3) keys.add(k.slice(1, -1));
  }
  // server messages people can see
  for (const m of read('apps-script/Code.gs').matchAll(/new Error\('([^']+)'\)/g)) keys.add(m[1]);
  // fixed page text outside the per-language blocks
  for (const page of ['index.html', 'driver.html']) {
    const html = read(page)
      .replace(/<(\w+)[^>]*data-lang="(en|es)"[^>]*>[\s\S]*?<\/\1>/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '');
    for (const m of html.matchAll(/>([^<>]+)</g)) {
      const k = m[1].replace(/&amp;/g, '&').trim();
      if (k && /[A-Za-z]{2}/.test(k)) keys.add(k);
    }
    for (const m of html.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/g)) if (/[A-Za-z]{2}/.test(m[1])) keys.add(m[1]);
  }
  return [...keys].filter((k) => !SAME.has(k));
}

test('every English text on screen has a Spanish version', () => {
  const missing = englishTexts().filter((k) => ES[k] == null);
  assert.deepEqual(missing, []);
});

test('Spanish keeps every {placeholder} and HTML tag of the English', () => {
  for (const [en, es] of Object.entries(ES)) {
    const marks = (s) => [...s.matchAll(/\{\w+\}|<\/?\w+/g)].map((m) => m[0]).sort();
    assert.deepEqual(marks(es), marks(en), en);
  }
});

test('both languages have the same per-language page blocks', () => {
  const html = read('index.html');
  assert.equal((html.match(/data-lang="en"/g) || []).length, (html.match(/data-lang="es"/g) || []).length);
});
