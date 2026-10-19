// Shared storage for the DUA Route Planner.
// Paste this into Extensions → Apps Script of a Google Sheet you own, change PASSCODE,
// then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// The planner keeps one JSON copy of the shared data in the "data" tab.

const PASSCODE = 'change-this-to-something-long';

function doGet(e) {
  if (!e.parameter || e.parameter.key !== PASSCODE) return reply({ error: 'Wrong passcode' });
  return reply({ data: load() });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ error: 'Bad request' });
  }
  if (body.key !== PASSCODE) return reply({ error: 'Wrong passcode' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    save(body.data);
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName('data') || ss.insertSheet('data');
}

// Cells hold at most 50,000 characters, so the JSON is split across rows.
// Each piece starts with "x" so Sheets never treats it as a number or formula.
function load() {
  const sh = sheet();
  const rows = sh.getLastRow();
  if (!rows) return null;
  const text = sh.getRange(1, 1, rows, 1).getValues().map((r) => String(r[0]).slice(1)).join('');
  return text ? JSON.parse(text) : null;
}

function save(data) {
  const text = JSON.stringify(data);
  const pieces = [];
  for (let i = 0; i < text.length; i += 45000) pieces.push(['x' + text.slice(i, i + 45000)]);
  const sh = sheet();
  sh.clearContents();
  if (pieces.length) sh.getRange(1, 1, pieces.length, 1).setValues(pieces);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
