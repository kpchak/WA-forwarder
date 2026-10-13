'use strict';

const express = require('express');
const router  = express.Router();
const rules   = require('../services/forwardRules');

// ── GET /api/forward-rules ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ rules: rules.list(), pending: rules.listPending() });
});

// ── POST /api/forward-rules ───────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    res.json({ ok: true, rule: rules.create(req.body) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── PUT /api/forward-rules/:id ────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    res.json({ ok: true, rule: rules.update(req.params.id, req.body) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── DELETE /api/forward-rules/:id ─────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    rules.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── POST /api/forward-rules/:id/check-now ─────────────────────────────────────
// Reads the source group immediately instead of waiting for the poll interval.
router.post('/:id/check-now', async (req, res) => {
  try {
    const matches = await rules.checkNow(req.params.id);
    res.json({ ok: true, matches, pending: rules.listPending() });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ── POST /api/forward-rules/pending/:id/approve ───────────────────────────────
router.post('/pending/:id/approve', async (req, res) => {
  try {
    const result = await rules.approve(req.params.id);
    res.json({ ok: true, result, pending: rules.listPending() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/forward-rules/pending/:id/dismiss ───────────────────────────────
router.post('/pending/:id/dismiss', (req, res) => {
  try {
    res.json({ ok: true, item: rules.dismiss(req.params.id), pending: rules.listPending() });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
