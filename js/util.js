export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// "11:30" -> 690
export function toMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// 690 -> "11:30 AM"
export function fmtTime(min) {
  if (min == null || Number.isNaN(min)) return '—';
  const total = Math.round(min);
  let h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

// 251 -> "4h 11m"
export function fmtDur(min) {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtMoney(n) {
  return '$' + n.toFixed(2);
}

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Days as English text for CSV files ("Mon-Fri", "Mon Wed Fri"); parseDays reads it back.
export function daysCode(days) {
  if (!days || !days.some(Boolean)) return '';
  if (days.every(Boolean)) return 'daily';
  if (!days[0] && days.slice(1, 7).every(Boolean)) return 'Mon-Sat';
  if (!days[0] && !days[6] && days.slice(1, 6).every(Boolean)) return 'Mon-Fri';
  return DAY_NAMES.filter((_, i) => days[i]).join(' ');
}

const DAY_TOKENS = {
  su: 0, sun: 0, sunday: 0,
  m: 1, mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  w: 3, we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  f: 5, fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

// "Mon Wed Fri", "M,W,F", "Mon-Fri", "daily" -> [bool x 7] (Sunday first)
export function parseDays(text) {
  const days = [false, false, false, false, false, false, false];
  const t = String(text || '').toLowerCase().trim();
  if (!t) return days;
  if (/^(daily|every ?day|all)$/.test(t)) return days.map(() => true);
  for (const part of t.split(/[\s,;/]+/).filter(Boolean)) {
    const range = part.split(/[-–]/);
    if (range.length === 2 && range[0] in DAY_TOKENS && range[1] in DAY_TOKENS) {
      let i = DAY_TOKENS[range[0]];
      const end = DAY_TOKENS[range[1]];
      days[i] = true;
      while (i !== end) {
        i = (i + 1) % 7;
        days[i] = true;
      }
    } else if (part in DAY_TOKENS) {
      days[DAY_TOKENS[part]] = true;
    }
  }
  return days;
}

// Minimal CSV parser with quoted fields.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

export function toCsv(rows) {
  return rows
    .map((r) => r.map((f) => (/[",\n]/.test(String(f ?? '')) ? `"${String(f).replace(/"/g, '""')}"` : String(f ?? ''))).join(','))
    .join('\n');
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      f.text().then(resolve);
    };
    input.click();
  });
}

// "2026-10-21" -> "2026-10-19" (the Monday of that week)
export function weekStart(dateStr) {
  const wd = weekdayOf(dateStr);
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

// 450 -> "7.5"
export function fmtHours(min) {
  return (Math.round((min / 60) * 10) / 10).toFixed(1);
}

// 935 -> "15:35" (for <input type="time">)
export function fmtTimeInput(min) {
  if (min == null) return '';
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
