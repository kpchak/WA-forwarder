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
// Requires an explicit confirm. A bare DELETE is refused on purpose: a cleanup
// script looped over every rule and deleted them all, including ones a person
// had created, and the configuration was unrecoverable. The UI's confirm dialog
// does not help a script — this does.
router.delete('/:id', (req, res) => {
  const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
  if (!confirmed) {
    return res.status(400).json({
      error: 'Refusing to delete without confirmation — pass ?confirm=1 (the UI does this for you)',
    });
  }
  try {
    const result = rules.remove(req.params.id);
    res.json({ ok: true, backup: result.backup, deleted: result.deleted.label });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── GET /api/forward-rules/backups ────────────────────────────────────────────
router.get('/backups', (req, res) => {
  res.json({ backups: rules.listBackups() });
});

// ── POST /api/forward-rules/backups/:file/restore ─────────────────────────────
router.post('/backups/:file/restore', (req, res) => {
  try {
    res.json({ ok: true, restored: rules.restoreBackup(req.params.file) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/forward-rules/:id/check-now ─────────────────────────────────────
// Reads the source group immediately instead of waiting for the poll interval.
router.post('/:id/check-now', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    const range = from
      ? { fromSec: Math.floor(Number(from) / 1000),
          toSec:   to ? Math.floor(Number(to) / 1000) : Infinity }
      : null;
    const matches = await rules.checkNow(req.params.id, range);
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
