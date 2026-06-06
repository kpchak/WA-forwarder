'use strict';

const express = require('express');
const router = express.Router();
const wa = require('../whatsapp/client');

// GET /api/status
router.get('/status', (req, res) => {
  res.json({ state: wa.getState(), qr: wa.getQR() });
});

// POST /api/session/clear
router.post('/session/clear', async (req, res) => {
  try {
    await wa.clearSession();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
