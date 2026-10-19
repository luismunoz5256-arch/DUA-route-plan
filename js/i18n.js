// English / Spanish. English text is the key; es.js holds the Spanish for each one.
// The choice is kept per browser (also after logging out).
import { ES } from './es.js';

const KEY = 'dua.lang';

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch {}
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export const lang = detect();
export const locale = lang === 'es' ? 'es-MX' : 'en-US';

// t('Back {time}', { time: '3:40 PM' })
export function t(text, vars) {
  let s = lang === 'es' && ES[text] != null ? ES[text] : text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}

// Switching language reloads the page; everything on screen is rebuilt from saved data.
export function setLang(l) {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  location.reload();
}

export function dayNames() {
  return lang === 'es' ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
}

// Translates the page's fixed text: text nodes and placeholder/title/aria-label attributes
// that exactly match an English key, and shows only the [data-lang] blocks for this language.
export function translatePage(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-lang]').forEach((el) => (el.hidden = el.dataset.lang !== lang));
  if (lang === 'en') return;
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const key = n.nodeValue.trim();
    if (key && ES[key] != null) n.nodeValue = n.nodeValue.replace(key, ES[key]);
  }
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      const v = el.getAttribute(attr);
      if (ES[v] != null) el.setAttribute(attr, ES[v]);
    });
  }
  if (ES[document.title]) document.title = ES[document.title];
}

// A small "English | Español" switch.
export function langSwitch() {
  const other = lang === 'es' ? 'en' : 'es';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link lang-switch';
  b.textContent = other === 'es' ? 'Español' : 'English';
  b.addEventListener('click', () => setLang(other));
  return b;
}
