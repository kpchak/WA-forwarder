'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');

const STORE_PATH = path.join(__dirname, '../../data/message-templates.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')).templates || [];
  } catch { return []; }
}

function save(templates) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({ templates }, null, 2));
}

// ── GET /api/templates ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ templates: load() });
});

// ── POST /api/templates ───────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, text } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

  const templates = load();
  const existing  = templates.findIndex((t) => t.name.toLowerCase() === name.trim().toLowerCase());

  if (existing !== -1) {
    // Overwrite if same name
    templates[existing] = { ...templates[existing], text: text.trim(), updatedAt: new Date().toISOString() };
  } else {
    templates.push({
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name:      name.trim(),
      text:      text.trim(),
      createdAt: new Date().toISOString(),
    });
  }

  save(templates);
  res.json({ ok: true, templates });
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const before    = load();
  const templates = before.filter((t) => t.id !== req.params.id);
  if (templates.length === before.length) return res.status(404).json({ error: 'Not found' });
  save(templates);
  res.json({ ok: true, templates });
});

module.exports = router;
