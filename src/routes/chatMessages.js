'use strict';

const express          = require('express');
const router           = express.Router();
const wa               = require('../whatsapp/client');
const sheets           = require('../services/sheets');
const { MessageMedia }   = require('whatsapp-web.js');
const { resolveTemplates } = require('../utils/templates');
const { toWAId: _toWAId } = require("../utils/waId");

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

// GET /api/chat-messages/health — cheap liveness probe that still touches the
// page, so a detached frame surfaces in the response. The watchdog used to poll
// /chats for this, but getChats() sweeps every chat (671 here) and is heavy
// enough to detach the frame by itself — the monitor was destabilising the
// client it exists to protect. getState() reaches into the same page without
// enumerating anything.
router.get('/health', async (req, res) => {
  try {
    if (wa.getState() !== 'ready') return res.json({ ok: false, state: wa.getState() });
    const waState = await wa.getClient().getState();
    res.json({ ok: waState === 'CONNECTED', state: waState });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/chat-messages/wa-groups — every group this account belongs to, with
// the id to paste into the sheet. Backed by getChats(), which sweeps the whole
// chat list and has detached the frame before, so the result is cached and only
// re-read when ?refresh=1 is asked for explicitly. The UI never calls it on its
// own for the same reason.
const SWEEP_TTL_MS = 10 * 60 * 1000;
const _sweep = { chats: null, groups: null, at: 0 };
let _sweepLock = null;   // one sweep at a time, however many callers want it

function _chatId(c) {
  return String(c.id?._serialized || c.id?.$1 || '');   // $1: renamed by WhatsApp, Jul 2026
}

/**
 * getChats() once, shared by the group picker and by group message loading.
 * It is the heavy call that detached the frame repeatedly in late September, so
 * it is cached, never run concurrently, and never triggered just by opening a
 * tab — only by an explicit Load, or by a load that actually names a group.
 */
async function _chatSweep(force = false) {
  if (!force && _sweep.chats && Date.now() - _sweep.at < SWEEP_TTL_MS) return _sweep;
  if (_sweepLock) return _sweepLock;

  _sweepLock = (async () => {
    await wa.assertConnected();
    const chats = await wa.getClient().getChats();
    _sweep.chats  = chats;
    _sweep.groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        name: c.name || '(unnamed group)',
        id:   _chatId(c).replace(/@g\.us$/, ''),
        lastActivity: c.timestamp || 0,
      }))
      .filter((g) => g.id)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    _sweep.at = Date.now();
    return _sweep;
  })().finally(() => { _sweepLock = null; });

  return _sweepLock;
}

router.get('/wa-groups', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (!refresh && _sweep.groups) {
    return res.json({ groups: _sweep.groups, cachedAt: _sweep.at, cached: true });
  }
  try {
    const s = await _chatSweep(true);
    res.json({ groups: s.groups, cachedAt: s.at, cached: false });
  } catch (err) {
    console.warn('[ChatMessages] wa-groups failed:', err.message);
    res.status(503).json({ error: err.message });
  }
});

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

    const warnings = [];

    // Groups can only be reached through the chat sweep — getChatById() on a
    // group id detaches the frame. Sweep once up front, and only when a group
    // is actually selected, rather than once per contact inside the loop.
    let groupIndex = null;
    if (uniquePhones.some((p) => (_toWAId(p) || '').endsWith('@g.us'))) {
      try {
        const sweep = await _chatSweep();
        groupIndex = new Map((sweep.chats || []).map((c) => [_chatId(c), c]));
      } catch (err) {
        warnings.push(`Could not read the group list: ${err.message}`);
      }
    }

    // Fetching every contact at once is what detaches the frame: a busy group
    // can return the full 500-message page, and several of those in flight
    // together overwhelm the page. Two groups in parallel worked; four did not.
    // DMs are cheap and stay parallel; groups are fetched one at a time.
    const fetchOne = async (phone) => {
      const waId = _toWAId(phone);
      if (!waId) return [];
      try {
        let chat;
        if (waId.endsWith('@g.us')) {
          chat = groupIndex?.get(waId);
          if (!chat) {
            warnings.push(`${phone}: group not found in the WhatsApp chat list`);
            console.warn(`[ChatMessages] Group ${waId} not in chat list — skipped`);
            return [];
          }
        } else {
          chat = await client.getChatById(waId);
        }
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
        // Report rather than swallow: a failed lookup used to be indistinguishable
        // from a contact with nothing to say, so a crashed client looked exactly
        // like "no messages today".
        warnings.push(`${phone}: ${err.message}`);
        console.warn(`[ChatMessages] No chat for ${phone}: ${err.message}`);
        return [];
      }
    };

    const isGroupPhone = (p) => (_toWAId(p) || '').endsWith('@g.us');
    const dmPhones     = uniquePhones.filter((p) => !isGroupPhone(p));
    const groupPhones  = uniquePhones.filter(isGroupPhone);

    const perPhone = await Promise.all(dmPhones.map(fetchOne));
    for (const phone of groupPhones) {
      perPhone.push(await fetchOne(phone));
      if (groupPhones.length > 1) await _sleep(300);   // let the page breathe
    }

    const messages = perPhone.flat().sort((a, b) => a.timestamp - b.timestamp);
    res.json(warnings.length ? { messages, warnings } : { messages });
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

    // Forwarding into a disconnected page reports success and delivers nothing.
    try {
      await wa.assertConnected();
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
    const { messageIds, targetGroupName, contacts, prefix, caption } = req.body;
    console.log('[Forward] prefix=%j  caption=%j  contacts=%d', prefix, caption, contacts?.length ?? 0);
    if (!messageIds?.length) return res.status(400).json({ error: 'messageIds required' });
    if (!contacts?.length && !targetGroupName) return res.status(400).json({ error: 'contacts or targetGroupName required' });

    let members;
    if (contacts?.length) {
      members = contacts;
    } else {
      const groups = await sheets.fetchGroups(false);
      const group  = groups.find((g) => g.name === targetGroupName);
      if (!group) return res.status(404).json({ error: `Group "${targetGroupName}" not found` });
      members = group.members;
    }
    if (!members.length) return res.status(400).json({ error: 'No contacts to send to' });

    const client = wa.getClient();
    const now    = new Date();

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
    for (const member of members) {
      const waId = _toWAId(member.phone);
      if (!waId) { results.push({ name: member.name, phone: member.phone, ok: false, error: 'Invalid phone' }); continue; }
      const name = member.name || '';
      const pre  = resolveTemplates(prefix  || '', now, name);
      const cap  = resolveTemplates(caption || '', now, name);
      try {
        for (const p of payloads) {
          const bodyText = resolveTemplates(p.text || '', now, name);
          if (p.media) {
            const mediaCaption = [pre, bodyText, cap].filter(Boolean).join('\n\n');
            await client.sendMessage(waId, p.media, { caption: mediaCaption });
          } else {
            const txt = [pre, bodyText, cap].filter(Boolean).join('\n\n');
            if (txt) await client.sendMessage(waId, txt);
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


function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = router;
