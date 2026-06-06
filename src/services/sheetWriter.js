'use strict';

const { google } = require('googleapis');

const TZ             = process.env.SCHEDULE_TIMEZONE || 'Asia/Kolkata';
const SPREADSHEET_ID = () => process.env.GOOGLE_SPREADSHEET_ID;

function _auth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').split('\\n').join('\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function _sheets() {
  return google.sheets({ version: 'v4', auth: _auth() });
}

// Format Unix seconds to { date: 'YYYY-MM-DD', time: 'hh:mm:ss AM/PM' } in server TZ
function _formatTS(unixSec) {
  const d    = new Date(unixSec * 1000);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(d);
  return { date, time };
}

// Convert 0-based column index to letter (0→A, 7→H, 25→Z, 26→AA…)
function _colLetter(idx) {
  let result = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// Ensure tab exists; if brand-new, write defaultHeaders to row 1
async function _ensureSheetExists(api, id, sheetName, defaultHeaders) {
  const meta     = await api.spreadsheets.get({ spreadsheetId: id });
  const existing = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!existing) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody:   { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId:    id,
      range:            `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody:      { values: [defaultHeaders] },
    });
  }
}

// Read current header row and ensure all requiredCols exist.
// Returns a map of { colName → 0-based index } for all required columns.
async function _getColMap(api, id, sheetName, requiredCols) {
  const res      = await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${sheetName}'!1:1` });
  const existing = res.data.values?.[0] || [];
  const lower    = existing.map((h) => h.toLowerCase().trim());

  const colMap = {};
  const toAdd  = [];

  for (const col of requiredCols) {
    const idx = lower.indexOf(col.toLowerCase());
    if (idx !== -1) {
      colMap[col] = idx;
    } else {
      colMap[col] = existing.length + toAdd.length;
      toAdd.push(col);
    }
  }

  // Append missing headers after the last existing column
  if (toAdd.length > 0) {
    const startIdx    = existing.length;
    const startLetter = _colLetter(startIdx);
    const endLetter   = _colLetter(startIdx + toAdd.length - 1);
    await api.spreadsheets.values.update({
      spreadsheetId:    id,
      range:            `'${sheetName}'!${startLetter}1:${endLetter}1`,
      valueInputOption: 'RAW',
      requestBody:      { values: [toAdd] },
    });
  }

  return colMap;
}

// Build a row array of the right length from a field map
function _buildRow(colMap, fields) {
  const width = Math.max(...Object.values(colMap)) + 1;
  const row   = new Array(width).fill('');
  for (const [col, val] of Object.entries(fields)) {
    if (colMap[col] !== undefined) row[colMap[col]] = val;
  }
  return row;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Return sorted unique codes from the Code column of CodeMonitor
async function getCodes() {
  const api = _sheets();
  const id  = SPREADSHEET_ID();
  try {
    const res     = await api.spreadsheets.values.get({ spreadsheetId: id, range: `'CodeMonitor'!A:Z` });
    const rows    = res.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.toLowerCase().trim());
    const codeIdx = headers.indexOf('code');
    if (codeIdx === -1) return [];
    const codes = new Set();
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i][codeIdx]?.trim();
      if (c) codes.add(c);
    }
    return [...codes].sort();
  } catch (err) {
    if (err.code === 400 || err.message?.includes('Unable to parse range')) return [];
    throw err;
  }
}

// Append attendance rows to the Attendance sheet
// entries: [{ timestamp, group, memberName, message }]
async function appendAttendance(entries) {
  const api  = _sheets();
  const id   = SPREADSHEET_ID();
  const COLS = ['Date', 'Time', 'Group', 'Member', 'Message', 'TimeZone'];

  await _ensureSheetExists(api, id, 'Attendance', COLS);
  const colMap = await _getColMap(api, id, 'Attendance', COLS);

  const rows = entries.map((e) => {
    const { date, time } = _formatTS(e.timestamp);
    return _buildRow(colMap, { Date: date, Time: time, Group: e.group, Member: e.memberName, Message: e.message, TimeZone: TZ });
  });

  await api.spreadsheets.values.append({
    spreadsheetId:    id,
    range:            `'Attendance'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: rows },
  });

  return rows.length;
}

// Append code-monitor rows to the CodeMonitor sheet
// entries: [{ timestamp, group, memberName, message }], code: string
async function appendCodeMonitor(entries, code) {
  const api  = _sheets();
  const id   = SPREADSHEET_ID();
  const COLS = ['Date', 'Time', 'Group', 'Member', 'Message', 'TimeZone', 'Code'];

  await _ensureSheetExists(api, id, 'CodeMonitor', COLS);
  const colMap = await _getColMap(api, id, 'CodeMonitor', COLS);

  const rows = entries.map((e) => {
    const { date, time } = _formatTS(e.timestamp);
    return _buildRow(colMap, { Date: date, Time: time, Group: e.group, Member: e.memberName, Message: e.message, TimeZone: TZ, Code: code });
  });

  await api.spreadsheets.values.append({
    spreadsheetId:    id,
    range:            `'CodeMonitor'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: rows },
  });

  return rows.length;
}

// Debug: return raw sheet state for troubleshooting
async function debugReadSheets() {
  const api  = _sheets();
  const id   = SPREADSHEET_ID();
  const meta = await api.spreadsheets.get({ spreadsheetId: id });
  const tabs = meta.data.sheets.map((s) => s.properties.title);

  const read = async (name) => {
    if (!tabs.includes(name)) return null;
    const res = await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${name}'!A:Z` });
    return res.data.values || [];
  };

  return {
    tabs,
    attendanceRows:   await read('Attendance'),
    codeMonitorRows:  await read('CodeMonitor'),
  };
}

module.exports = { getCodes, appendAttendance, appendCodeMonitor, debugReadSheets };
