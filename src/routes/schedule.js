'use strict';

const express   = require('express');
const router    = express.Router();
const scheduler = require('../services/scheduler');

// GET /api/schedules
router.get('/', (req, res) => {
  res.json({ schedules: scheduler.getAll() });
});

// POST /api/schedules
router.post('/', (req, res) => {
  try {
    const schedule = scheduler.create(req.body);
    res.status(201).json({ ok: true, schedule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/schedules/:id
router.put('/:id', (req, res) => {
  try {
    const schedule = scheduler.update(req.params.id, req.body);
    res.json({ ok: true, schedule });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id
router.delete('/:id', (req, res) => {
  try {
    scheduler.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/schedules/:id/toggle
router.post('/:id/toggle', (req, res) => {
  try {
    const schedule = scheduler.toggle(req.params.id);
    res.json({ ok: true, schedule });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
