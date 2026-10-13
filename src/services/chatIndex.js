'use strict';

const wa = require('../whatsapp/client');

/**
 * The one place getChats() is called.
 *
 * Sweeping every chat is the heaviest thing this app asks of the WhatsApp page
 * and has detached the Puppeteer frame repeatedly. Two callers sweeping
 * independently would double that, so the message loader and the forward poller
 * share this cache and this lock.
 *
 * Two failure modes are specific to a client that has just restarted: getChats()
 * returns an empty list, or a partial one. Neither is cached as truth — a cached
 * empty sweep reports every group as "not found" for the whole TTL, which is
 * both wrong and very hard to read back.
 */
const TTL_MS = 10 * 60 * 1000;

const _cache = { chats: null, groups: null, at: 0 };
let _lock = null;

function chatId(c) {
  return String(c.id?._serialized || c.id?.$1 || '');   // $1: renamed by WhatsApp, Jul 2026
}

async function sweep(force = false) {
  if (!force && _cache.chats && Date.now() - _cache.at < TTL_MS) return _cache;
  if (_lock) return _lock;

  _lock = (async () => {
    await wa.assertConnected();
    const chats = await wa.getClient().getChats();

    if (!chats.length) {
      throw new Error('WhatsApp returned an empty chat list — the client is still settling, try again shortly');
    }

    _cache.chats  = chats;
    _cache.groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        name: c.name || '(unnamed group)',
        id:   chatId(c).replace(/@g\.us$/, ''),
        lastActivity: c.timestamp || 0,
      }))
      .filter((g) => g.id)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    _cache.at = Date.now();
    return _cache;
  })().finally(() => { _lock = null; });

  return _lock;
}

/** Cached groups without forcing a sweep, or null if nothing cached yet. */
function cachedGroups() {
  return _cache.groups ? { groups: _cache.groups, at: _cache.at } : null;
}

/**
 * Resolve one chat by JID. Re-sweeps once on a miss: a partial list from a
 * settling client would otherwise be reported as "this chat does not exist".
 */
async function findChat(waId) {
  let s = await sweep();
  let hit = (s.chats || []).find((c) => chatId(c) === waId);
  if (!hit) {
    s = await sweep(true);
    hit = (s.chats || []).find((c) => chatId(c) === waId);
  }
  return hit || null;
}

module.exports = { sweep, cachedGroups, findChat, chatId, TTL_MS };
