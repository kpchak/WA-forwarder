'use strict';

const express = require('express');
const router  = express.Router();
const sheets  = require('../services/sheets');

// Each group is one tab of the spreadsheet, so it can link straight to its own
// tab. gid is only present on groups synced since it started being captured;
// without one the link still opens the spreadsheet.
function _withSheetUrls(groups) {
  return (groups || []).map((g) => ({ ...g, sheetUrl: sheets.spreadsheetUrl(g.gid) }));
}

// ── GET /api/groups ───────────────────────────────────────────────────────────
// Serves saved sheet groups from local file — no WhatsApp matching.
router.get('/', async (req, res) => {
  try {
    if (!sheets.isConfigured()) {
      return res.json({ configured: false, groups: [], storeInfo: null });
    }
    const groups = await sheets.fetchGroups(false);
    res.json({
      configured: true,
      groups: _withSheetUrls(groups),
      spreadsheetUrl: sheets.spreadsheetUrl(),
      storeInfo: sheets.getStoreInfo(),
    });
  } catch (err) {
    console.error('[Groups API] GET /', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/groups/sync ─────────────────────────────────────────────────────
// Fetches fresh data from Google Sheets and saves to local file.
router.post('/sync', async (req, res) => {
  try {
    const groups = await sheets.fetchGroups(true);
    res.json({
      ok: true,
      groups: _withSheetUrls(groups),
      spreadsheetUrl: sheets.spreadsheetUrl(),
      storeInfo: sheets.getStoreInfo(),
    });
  } catch (err) {
    console.error('[Groups API] POST /sync', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
