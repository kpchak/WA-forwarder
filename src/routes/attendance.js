'use strict';

const express    = require('express');
const router     = express.Router();
const attendance = require('../services/attendance');
const sheets     = require('../services/sheets');

// ── GET /api/attendance?group=&date= ──────────────────────────────────────────
// Returns all members of the group with their attendance status for the date.
// Members with no record show as "unmarked".
router.get('/', async (req, res) => {
  try {
    const { group, date = _today() } = req.query;
    if (!group) return res.status(400).json({ error: 'group is required' });

    const [records, allGroups] = await Promise.all([
      Promise.resolve(attendance.getForDay(group, date)),
      sheets.fetchGroups(false),
    ]);

    const groupData = allGroups.find((g) => g.name === group);
    const members   = groupData?.members ?? [];

    // Merge: every member from Sheets + their record if any
    const recordsByPhone = new Map(records.map((r) => [r.memberPhone, r]));

    const rows = members.map((m) => {
      const record = recordsByPhone.get(m.phone) || null;
      return {
        memberName:  m.name,
        memberPhone: m.phone,
        status:      record?.status  || 'unmarked',
        code:        record?.code    || '',
        source:      record?.source  || '',
        timestamp:   record?.timestamp || null,
      };
    });

    // Also include any records from phone numbers NOT in the Sheets list
    // (e.g. someone not on the list sent a code)
    const sheetPhones = new Set(members.map((m) => m.phone));
    records
      .filter((r) => !sheetPhones.has(r.memberPhone))
      .forEach((r) => rows.push({
        memberName:  r.memberName || r.memberPhone,
        memberPhone: r.memberPhone,
        status:      r.status,
        code:        r.code,
        source:      r.source,
        timestamp:   r.timestamp,
        unknown:     true,   // not in Sheets list
      }));

    res.json({
      date,
      group,
      members: rows,
      summary: attendance.getSummary(group, date),
    });
  } catch (err) {
    console.error('[Attendance] GET /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/attendance/mark ─────────────────────────────────────────────────
router.post('/mark', (req, res) => {
  try {
    const { groupName, memberPhone, memberName, date, status } = req.body;
    if (!groupName || !memberPhone || !status) {
      return res.status(400).json({ error: 'groupName, memberPhone, status are required' });
    }
    const record = attendance.mark({ groupName, memberPhone, memberName, date, status });
    res.json({ ok: true, record });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/attendance/unmark ───────────────────────────────────────────────
router.post('/unmark', (req, res) => {
  try {
    const { groupName, memberPhone, date } = req.body;
    if (!groupName || !memberPhone) {
      return res.status(400).json({ error: 'groupName and memberPhone are required' });
    }
    attendance.unmark(groupName, memberPhone, date || _today());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/attendance/config?group= ─────────────────────────────────────────
router.get('/config', (req, res) => {
  const { group } = req.query;
  if (group) return res.json(attendance.getConfig(group));
  res.json(attendance.getAllConfigs());
});

// ── POST /api/attendance/config ───────────────────────────────────────────────
router.post('/config', (req, res) => {
  try {
    const { groupName, presentCodes, lateCodes, absentCodes } = req.body;
    if (!groupName) return res.status(400).json({ error: 'groupName is required' });
    attendance.setConfig(groupName, { presentCodes, lateCodes, absentCodes });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/attendance/export?group=&from=&to= ───────────────────────────────
router.get('/export', (req, res) => {
  try {
    const { group, from = _today(), to = _today() } = req.query;
    if (!group) return res.status(400).json({ error: 'group is required' });
    const csv  = attendance.exportCSV(group, from, to);
    const filename = `attendance_${group.replace(/\s+/g, '_')}_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function _today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = router;
