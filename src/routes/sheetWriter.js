'use strict';

const express     = require('express');
const router      = express.Router();
const sheetWriter = require('../services/sheetWriter');

// GET /api/sheet-writer/codes
router.get('/codes', async (req, res) => {
  try {
    const codes = await sheetWriter.getCodes();
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheet-writer/debug — show raw sheet state for troubleshooting
router.get('/debug', async (req, res) => {
  try {
    const raw = await sheetWriter.debugReadSheets();
    res.json(raw);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheet-writer/attendance
// body: { entries: [{ timestamp, group, memberName, message }] }
router.post('/attendance', async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries?.length) return res.status(400).json({ error: 'entries required' });
    const written = await sheetWriter.appendAttendance(entries);
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheet-writer/code-monitor
// body: { entries: [{ timestamp, group, memberName, message }], code: string }
router.post('/code-monitor', async (req, res) => {
  try {
    const { entries, code } = req.body;
    if (!entries?.length)  return res.status(400).json({ error: 'entries required' });
    if (!code?.trim())     return res.status(400).json({ error: 'code required' });
    const written = await sheetWriter.appendCodeMonitor(entries, code.trim().toUpperCase());
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
