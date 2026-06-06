'use strict';

const fs   = require('fs');
const path = require('path');

const RECORDS_PATH = path.join(__dirname, '../../data/attendance.json');
const CONFIG_PATH  = path.join(__dirname, '../../data/attendance-config.json');

// ── In-memory state ───────────────────────────────────────────────────────────
let _records = [];   // all attendance records
let _config  = {};   // { [groupName]: { presentCodes, lateCodes, absentCodes } }

// ── Boot ──────────────────────────────────────────────────────────────────────
function init() {
  _records = _readJSON(RECORDS_PATH, []);
  _config  = _readJSON(CONFIG_PATH,  {});
  console.log(`[Attendance] ${_records.length} records loaded`);
}

// ── Config API ────────────────────────────────────────────────────────────────
function getConfig(groupName) {
  return _config[groupName] || { presentCodes: [], lateCodes: [], absentCodes: [] };
}

function getAllConfigs() { return _config; }

function setConfig(groupName, { presentCodes = [], lateCodes = [], absentCodes = [] }) {
  _config[groupName] = {
    presentCodes: _normaliseCodes(presentCodes),
    lateCodes:    _normaliseCodes(lateCodes),
    absentCodes:  _normaliseCodes(absentCodes),
  };
  _writeJSON(CONFIG_PATH, _config);
}

// ── Record API ────────────────────────────────────────────────────────────────

/**
 * Called by the WhatsApp message listener.
 * Returns the new/updated record if attendance was recorded, null otherwise.
 */
function processMessage({ groupName, senderPhone, senderName, body, timestamp }) {
  const cfg    = getConfig(groupName);
  const status = _matchCode(body, cfg);
  if (!status) return null;          // message not an attendance code

  // First valid message per member per day wins (manual override is allowed later)
  const date    = _toDate(timestamp);
  const existing = _findRecord(groupName, senderPhone, date);
  if (existing && existing.source === 'auto') return null;   // already auto-recorded today

  return _upsert({
    groupName, memberPhone: senderPhone, memberName: senderName,
    date, status, code: body.trim(), source: 'auto',
    timestamp: new Date(timestamp * 1000 || Date.now()).toISOString(),
  });
}

/** Manual mark (admin action). Always overwrites. */
function mark({ groupName, memberPhone, memberName, date, status }) {
  if (!['present','late','absent'].includes(status)) {
    throw new Error(`Invalid status "${status}"`);
  }
  return _upsert({
    groupName, memberPhone, memberName: memberName || '',
    date: date || _toDate(Date.now() / 1000),
    status, code: '', source: 'manual',
    timestamp: new Date().toISOString(),
  });
}

/** Remove a record (unmark). */
function unmark(groupName, memberPhone, date) {
  const before = _records.length;
  _records = _records.filter(
    (r) => !(r.groupName === groupName && r.memberPhone === memberPhone && r.date === date)
  );
  if (_records.length !== before) _saveRecords();
}

/** Get all records for a group on a given date. */
function getForDay(groupName, date) {
  return _records.filter((r) => r.groupName === groupName && r.date === date);
}

/** Get summary counts for a group/date. */
function getSummary(groupName, date) {
  const records = getForDay(groupName, date);
  return {
    present: records.filter((r) => r.status === 'present').length,
    late:    records.filter((r) => r.status === 'late').length,
    absent:  records.filter((r) => r.status === 'absent').length,
    total:   records.length,
  };
}

/** Generate CSV string for a group between two dates (inclusive). */
function exportCSV(groupName, fromDate, toDate) {
  const rows = _records.filter(
    (r) => r.groupName === groupName && r.date >= fromDate && r.date <= toDate
  ).sort((a, b) => a.date.localeCompare(b.date) || a.memberName.localeCompare(b.memberName));

  const lines = [
    'Date,Name,Phone,Status,Code,Source,Time',
    ...rows.map((r) =>
      [r.date, _csv(r.memberName), _csv(r.memberPhone), r.status, _csv(r.code), r.source, r.timestamp].join(',')
    ),
  ];
  return lines.join('\r\n');
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _upsert(record) {
  const idx = _records.findIndex(
    (r) => r.groupName === record.groupName &&
           r.memberPhone === record.memberPhone &&
           r.date === record.date
  );
  if (idx !== -1) {
    _records[idx] = { ..._records[idx], ...record };
  } else {
    record.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    _records.push(record);
  }
  _saveRecords();
  return idx !== -1 ? _records[idx] : _records[_records.length - 1];
}

function _findRecord(groupName, memberPhone, date) {
  return _records.find(
    (r) => r.groupName === groupName && r.memberPhone === memberPhone && r.date === date
  ) || null;
}

function _matchCode(body, cfg) {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();

  // If no codes configured, any short message (≤ 10 chars) = present
  const hasAnyConfig =
    cfg.presentCodes.length || cfg.lateCodes.length || cfg.absentCodes.length;

  if (!hasAnyConfig) {
    return trimmed.length <= 10 ? 'present' : null;
  }

  if (cfg.presentCodes.includes(upper)) return 'present';
  if (cfg.lateCodes.includes(upper))    return 'late';
  if (cfg.absentCodes.includes(upper))  return 'absent';
  return null;
}

function _normaliseCodes(arr) {
  return arr.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
}

/** Unix seconds → YYYY-MM-DD in local time */
function _toDate(unixSecs) {
  const d = new Date(unixSecs * 1000);
  return d.toISOString().slice(0, 10);
}

function _saveRecords() {
  _writeJSON(RECORDS_PATH, _records);
}

function _readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[Attendance] Could not read ${filePath}:`, err.message);
    return fallback;
  }
}

function _writeJSON(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[Attendance] Could not write ${filePath}:`, err.message);
  }
}

function _csv(val) {
  const s = String(val || '');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  init, getConfig, getAllConfigs, setConfig,
  processMessage, mark, unmark, getForDay, getSummary, exportCSV,
};
