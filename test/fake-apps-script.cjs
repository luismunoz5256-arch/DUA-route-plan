// Runs apps-script/Code.gs in Node with stand-ins for the Google services it uses,
// so the real server code can be tested (and used by browser tests).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// geotab(method, params, host) can stand in for MyGeotab: return a result or throw { name, message }.
exports.createServer = function createServer({ setupCode = 'test-setup-code', geotab = null } = {}) {
  const sheets = new Map();
  const properties = new Map();
  let today = null; // setToday('2026-10-21') pretends it's that day (for daily backups)

  // failWrites: make the next N setValues calls throw, like Google failing part way through a save.
  let failWrites = 0;
  function fakeSheet(name) {
    let rows = [];
    let maxRows = 1000;
    const lastRow = () => {
      let n = rows.length;
      while (n && (rows[n - 1] === '' || rows[n - 1] == null)) n--;
      return n;
    };
    return {
      getName: () => name,
      getLastRow: lastRow,
      getMaxRows: () => maxRows,
      insertRowsAfter: (after, n) => (maxRows += n),
      clearContents: () => (rows = []),
      getRange: (r, c, n) => ({
        getValues: () => rows.slice(r - 1, r - 1 + n).map((v) => [v]),
        setValues: (vals) => {
          if (r - 1 + vals.length > maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
          if (failWrites > 0) {
            failWrites--;
            throw new Error('Service error: Spreadsheets');
          }
          vals.forEach((v, i) => (rows[r - 1 + i] = v[0]));
        },
        clearContent: () => {
          for (let i = r - 1; i < r - 1 + n; i++) rows[i] = '';
        },
      }),
    };
  }

  const context = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets.get(n) || null,
        insertSheet: (n) => {
          const s = fakeSheet(n);
          sheets.set(n, s);
          return s;
        },
        getSheets: () => [...sheets.values()],
        deleteSheet: (s) => sheets.delete(s.getName()),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => properties.set(k, String(v)),
        deleteProperty: (k) => properties.delete(k),
        getKeys: () => [...properties.keys()],
      }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      formatDate: (d) => today || d.toISOString().slice(0, 10),
      computeDigest: (alg, text) => [...crypto.createHash(alg).update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/Denver' },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    UrlFetchApp: {
      fetch(url, opts) {
        const { host, pathname } = new URL(url);
        // Like the real MyGeotab: only /apiv1 answers.
        if (pathname !== '/apiv1') return { getContentText: () => '<html>Not Found</html>', getResponseCode: () => 404 };
        const { method, params } = JSON.parse(opts.payload);
        let body;
        try {
          body = { jsonrpc: '2.0', result: geotab(method, params, host) };
        } catch (e) {
          body = { jsonrpc: '2.0', error: { message: e.message, errors: [{ name: e.name, message: e.message }] } };
        }
        return { getContentText: () => JSON.stringify(body), getResponseCode: () => 200 };
      },
    },
    console: { error() {}, log() {} },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType: () => ({ text }) }),
    },
  };
  vm.createContext(context);
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')
    .replace("const SETUP_CODE = 'change-this-to-something-long';", `const SETUP_CODE = ${JSON.stringify(setupCode)};`);
  vm.runInContext(code + '\n;this.__doPost = doPost;', context);

  return {
    setToday(d) {
      today = d;
    },
    failNextWrites(n) {
      failWrites = n;
    },
    sheetNames: () => [...sheets.keys()],
    call(req) {
      return JSON.parse(context.__doPost({ postData: { contents: JSON.stringify(req) } }).text);
    },
  };
};
