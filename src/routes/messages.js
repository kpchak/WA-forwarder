'use strict';

const express                    = require('express');
const router                     = express.Router();
const { MessageMedia }           = require('whatsapp-web.js');
const wa                         = require('../whatsapp/client');
const sheets                     = require('../services/sheets');
const { resolveTemplates }       = require('../utils/templates');

// ── POST /api/messages/send ───────────────────────────────────────────────────
// Sends a message to every phone number in the named sheet group.
router.post('/send', async (req, res) => {
  try {
    const { groupName, text, media, memberPhones } = req.body;

    if (!groupName)             return res.status(400).json({ error: 'groupName is required' });
    if (!text && !media)        return res.status(400).json({ error: 'Provide text, media, or both' });
    if (wa.getState() !== 'ready') return res.status(503).json({ error: 'WhatsApp is not connected' });

    const groups = await sheets.fetchGroups(false);
    const group  = groups.find((g) => g.name === groupName);
    if (!group) return res.status(404).json({ error: `Group "${groupName}" not found in saved data` });
    if (!group.members.length) return res.status(400).json({ error: `Group "${groupName}" has no members` });

    const members = Array.isArray(memberPhones) && memberPhones.length
      ? group.members.filter((m) => memberPhones.includes(m.phone))
      : group.members;

    if (!members.length) return res.status(400).json({ error: 'No matching recipients found' });

    // Validate media size once (16 MB limit)
    if (media) {
      const bytes = (media.base64.length * 3) / 4;
      if (bytes > 16 * 1024 * 1024) return res.status(400).json({ error: 'Attachment exceeds 16 MB limit' });
    }

    const now    = new Date();
    const client = wa.getClient();
    const results = [];

    for (const member of members) {
      const waId = _toWAId(member.phone);
      if (!waId) {
        results.push({ name: member.name, phone: member.phone, ok: false, error: 'Invalid phone number' });
        continue;
      }

      const resolvedText = resolveTemplates(text, now, member.name || '');

      try {
        if (media) {
          const mediaObj = new MessageMedia(media.mimetype, media.base64, media.filename || 'file');
          await client.sendMessage(waId, mediaObj, { caption: resolvedText || '' });
        } else {
          await client.sendMessage(waId, resolvedText);
        }
        results.push({ name: member.name, phone: member.phone, ok: true });
      } catch (err) {
        results.push({ name: member.name, phone: member.phone, ok: false, error: err.message });
      }

      // Small delay between sends to avoid WhatsApp rate limiting
      await _sleep(500);
    }

    const sent   = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    res.json({ ok: true, sent, failed, total: results.length, results });
  } catch (err) {
    console.error('[Messages] send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/messages/groups ──────────────────────────────────────────────────
// Returns saved sheet groups for populating dropdowns.
router.get('/groups', async (req, res) => {
  try {
    const groups = await sheets.fetchGroups(false);
    res.json({
      groups: groups.map((g) => ({ name: g.name, memberCount: g.members.length })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a raw phone/ID string to a WhatsApp ID.
 * - Long number (≥15 digits) or already has @g.us  → group chat ID
 * - Regular phone number                            → individual contact
 */
function _toWAId(raw) {
  if (!raw) return null;
  const clean = raw.trim().replace(/\s/g, '');

  if (clean.endsWith('@g.us') || clean.endsWith('@c.us')) return clean;

  const digits = clean.replace(/\D/g, '');
  if (!digits) return null;

  // WhatsApp group IDs are 15–17 digits; phone numbers are 10–14
  return digits.length >= 15 ? `${digits}@g.us` : `${digits}@c.us`;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = router;
