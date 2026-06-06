'use strict';

const express          = require('express');
const router           = express.Router();
const wa               = require('../whatsapp/client');
const sheets           = require('../services/sheets');
const { MessageMedia } = require('whatsapp-web.js');

// Cache loaded Message objects (30-min TTL) so media can be fetched on demand
const _msgCache = new Map(); // serializedId → { msg, savedAt }
let   _lastPrune = 0;

function _pruneCache() {
  if (Date.now() - _lastPrune < 5 * 60 * 1000) return;
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of _msgCache) {
    if (v.savedAt < cutoff) _msgCache.delete(k);
  }
  _lastPrune = Date.now();
}

// GET /api/chat-messages/chats — list all WA chats sorted by recency
router.get('/chats', async (req, res) => {
  try {
    if (wa.getState() !== 'ready') return res.status(503).json({ error: 'WhatsApp not connected' });
    const chats = await wa.getClient().getChats();
    res.json({
      chats: chats
        .map((c) => ({
          id:        c.id._serialized,
          name:      c.name || c.id.user || c.id._serialized,
          isGroup:   c.isGroup,
          timestamp: c.timestamp || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat-messages/load — fetch messages for a list of phone numbers
router.post('/load', async (req, res) => {
  try {
    if (wa.getState() !== 'ready') return res.status(503).json({ error: 'WhatsApp not connected' });
    const { phones, from, to } = req.body;
    if (!phones?.length) return res.status(400).json({ error: 'phones is required' });

    const uniquePhones = [...new Set(phones)]; // guard against duplicate entries in sheet
    const client  = wa.getClient();
    const fromSec = from ? Math.floor(from / 1000) : 0;
    const toSec   = to   ? Math.floor(to   / 1000) : Infinity;

    _pruneCache();

    // Fetch each contact's DM chat in parallel
    const perPhone = await Promise.all(uniquePhones.map(async (phone) => {
      const waId = _toWAId(phone);
      if (!waId) return [];
      try {
        const chat = await client.getChatById(waId);
        const msgs = await chat.fetchMessages({ limit: 500 });
        const out  = [];
        for (const m of msgs) {
          if (m.timestamp < fromSec || m.timestamp > toSec) continue;
          const sid = m.id._serialized;
          _msgCache.set(sid, { msg: m, savedAt: Date.now() });
          out.push({
            id:           sid,
            fromMe:       m.fromMe,
            author:       (m.author || (!m.fromMe ? m.from : null) || '').replace(/@.*$/, ''),
            contactPhone: phone,
            body:         m.body || '',
            type:         m.type,
            hasMedia:     m.hasMedia,
            timestamp:    m.timestamp,
          });
        }
        return out;
      } catch (err) {
        console.warn(`[ChatMessages] No chat for ${phone}: ${err.message}`);
        return [];
      }
    }));

    const messages = perPhone.flat().sort((a, b) => a.timestamp - b.timestamp);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat-messages/media/:msgId — download media for a cached message
router.get('/media/:msgId', async (req, res) => {
  try {
    _pruneCache();
    const entry = _msgCache.get(decodeURIComponent(req.params.msgId));
    if (!entry) return res.status(404).json({ error: 'Message not cached — reload messages first' });
    const media = await entry.msg.downloadMedia();
    if (!media) return res.status(404).json({ error: 'No media on this message' });
    res.json({ data: media.data, mimetype: media.mimetype, filename: media.filename || 'attachment' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat-messages/forward — forward selected messages to a sheet group
router.post('/forward', async (req, res) => {
  try {
    if (wa.getState() !== 'ready') return res.status(503).json({ error: 'WhatsApp not connected' });
    const { messageIds, targetGroupName, caption } = req.body;
    if (!messageIds?.length) return res.status(400).json({ error: 'messageIds required' });
    if (!targetGroupName)    return res.status(400).json({ error: 'targetGroupName required' });

    const groups = await sheets.fetchGroups(false);
    const group  = groups.find((g) => g.name === targetGroupName);
    if (!group)                return res.status(404).json({ error: `Group "${targetGroupName}" not found` });
    if (!group.members.length) return res.status(400).json({ error: `Group "${targetGroupName}" has no members` });

    const client = wa.getClient();

    // Download media up-front (once) before iterating members
    const payloads = [];
    for (const msgId of messageIds) {
      const entry = _msgCache.get(msgId);
      if (!entry) { payloads.push({ text: '[Message expired — reload messages]', media: null }); continue; }
      const m = entry.msg;
      let mediaObj = null;
      if (m.hasMedia) {
        try {
          const dl = await m.downloadMedia();
          if (dl) mediaObj = new MessageMedia(dl.mimetype, dl.data, dl.filename || 'file');
        } catch (_) {}
      }
      payloads.push({ text: m.body || '', media: mediaObj });
    }

    const results = [];
    for (const member of group.members) {
      const waId = _toWAId(member.phone);
      if (!waId) { results.push({ name: member.name, phone: member.phone, ok: false, error: 'Invalid phone' }); continue; }
      try {
        for (const p of payloads) {
          if (p.media) {
            const cap = caption ? (p.text ? `${p.text}\n\n${caption}` : caption) : (p.text || '');
            await client.sendMessage(waId, p.media, { caption: cap });
          } else if (p.text || caption) {
            const txt = caption ? (p.text ? `${p.text}\n\n${caption}` : caption) : p.text;
            await client.sendMessage(waId, txt);
          }
          await _sleep(300);
        }
        results.push({ name: member.name, phone: member.phone, ok: true });
      } catch (err) {
        results.push({ name: member.name, phone: member.phone, ok: false, error: err.message });
      }
      await _sleep(500);
    }

    const sent   = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    res.json({ ok: true, sent, failed, total: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function _toWAId(raw) {
  if (!raw) return null;
  const clean = raw.trim().replace(/\s/g, '');
  if (clean.endsWith('@g.us') || clean.endsWith('@c.us')) return clean;
  const digits = clean.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length >= 15 ? `${digits}@g.us` : `${digits}@c.us`;
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = router;
