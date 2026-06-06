'use strict';

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../../data/groups.json');

// In-memory copy — loaded from file on first call, updated on Refresh
let _groups = null;         // null = not yet loaded from file
let _savedAt = null;        // ISO string of when the file was last written
let _fetchLock = null;      // Promise — prevents parallel Sheets API calls

// ── Public API ────────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY &&
    process.env.GOOGLE_SPREADSHEET_ID
  );
}

/**
 * Return groups.
 *  - Normal call  → reads local file (no network).
 *  - forceRefresh → fetches from Google Sheets, saves to file, updates memory.
 */
async function fetchGroups(forceRefresh = false) {
  if (forceRefresh) {
    if (!isConfigured()) throw new Error('Google Sheets is not configured.');
    return _fetchAndSave();
  }

  // Serve from memory if already loaded
  if (_groups !== null) return _groups;

  // Load from local file
  _loadFromFile();
  return _groups;
}

function getStoreInfo() {
  return {
    hasSavedData: _groups !== null && _groups.length > 0,
    savedAt: _savedAt,
    groupCount: _groups?.length ?? 0,
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _loadFromFile() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      _groups = [];
      _savedAt = null;
      return;
    }
    const raw  = fs.readFileSync(STORE_PATH, 'utf8');
    const json = JSON.parse(raw);
    _groups  = json.groups  ?? [];
    _savedAt = json.savedAt ?? null;
    console.log(`[Sheets] Loaded ${_groups.length} groups from local file`);
  } catch (err) {
    console.warn('[Sheets] Could not read local file:', err.message);
    _groups  = [];
    _savedAt = null;
  }
}

function _saveToFile(groups) {
  const savedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({ savedAt, groups }, null, 2));
  } catch (err) {
    console.error('[Sheets] Could not write local file:', err.message);
  }
  _groups  = groups;
  _savedAt = savedAt;
}

async function _fetchAndSave() {
  if (_fetchLock) return _fetchLock;

  _fetchLock = _fetchFromSheets()
    .then((groups) => { _saveToFile(groups); return groups; })
    .finally(() => { _fetchLock = null; });

  return _fetchLock;
}

async function _fetchFromSheets() {
  // googleapis v164+ requires GoogleAuth with credentials object.
  // The private key in .env has literal \n sequences — split/join converts them.
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').split('\\n').join('\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets        = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  // Get all tab names
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs  = meta.data.sheets.map((s) => s.properties.title);
  if (tabs.length === 0) return [];

  // Batch-fetch every tab in one request
  const batchRes = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map((t) => `'${t}'!A:Z`),
  });

  const groups = [];

  for (let i = 0; i < tabs.length; i++) {
    const tabName = tabs[i];
    const rows    = batchRes.data.valueRanges[i]?.values ?? [];
    if (rows.length < 2) continue;

    const headers  = rows[0].map((h) => h.toLowerCase().trim());
    const nameIdx  = _findCol(headers, ['name', 'customer', 'member']);
    const phoneIdx = _findCol(headers, ['phone', 'number', 'mobile', 'whatsapp', 'contact']);
    const codeIdx  = _findCol(headers, ['code', 'attendance code', 'att']);

    if (nameIdx === -1 || phoneIdx === -1) {
      console.warn(`[Sheets] Tab "${tabName}": no Name/Phone columns found — skipped`);
      continue;
    }

    const members = [];
    for (let r = 1; r < rows.length; r++) {
      const row   = rows[r];
      const name  = row[nameIdx]?.trim()  || '';
      const rawPh = row[phoneIdx]?.trim() || '';
      if (!name && !rawPh) continue;
      members.push({
        name,
        phone:          _normalisePhone(rawPh),
        attendanceCode: codeIdx !== -1 ? (row[codeIdx]?.trim() || '') : '',
      });
    }

    if (members.length > 0) groups.push({ name: tabName, members });
  }

  console.log(`[Sheets] Fetched ${groups.length} groups from Google Sheets`);
  return groups;
}

function _findCol(headers, keywords) {
  for (let i = 0; i < headers.length; i++) {
    if (keywords.some((kw) => headers[i].includes(kw))) return i;
  }
  return -1;
}

function _normalisePhone(raw) {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.endsWith('@g.us') || lower.endsWith('@c.us')) return raw.replace(/\s/g, '');
  return raw.replace(/\D/g, '');
}

module.exports = { fetchGroups, isConfigured, getStoreInfo };
