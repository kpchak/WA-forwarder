'use strict';

const fs   = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

const wa         = require('../whatsapp/client');
const chatIndex  = require('./chatIndex');
const sheets     = require('./sheets');
const { toWAId } = require('../utils/waId');
const { resolveTemplates } = require('../utils/templates');

const RULES_PATH   = path.join(__dirname, '../../data/forward-rules.json');
const PENDING_PATH = path.join(__dirname, '../../data/forward-pending.json');
const SEEN_PATH    = path.join(__dirname, '../../data/forward-seen.json');

const TICK_MS        = 60 * 1000;   // decide what to poll once a minute
const SETTLE_MS      = 3 * 60 * 1000; // leave a freshly-started client alone
const FETCH_LIMIT    = 50;          // a window's worth, not a history crawl
const SEEN_CAP       = 1000;
const BACKOFF_TICKS  = 5;           // skip this many ticks after a failed poll

let _rules   = [];
let _pending = [];
let _seen    = [];
let _timer   = null;
let _backoff = 0;
let _startedAt = Date.now();

// Matched Message objects, kept so an approval can still forward media. Lost on
// restart, in which case the pending entry falls back to text only.
const _msgObjects = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────
function _read(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[Forward] Could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function _write(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[Forward] Could not write ${path.basename(file)}: ${err.message}`);
  }
}

const BACKUP_DIR  = path.join(__dirname, '../../data/forward-backups');
const KEEP_BACKUPS = 30;

/**
 * Snapshot rules + pending before anything destructive.
 *
 * Written after a cleanup script deleted every rule and dismissed every pending
 * item, including ones a person had created: the pending entries survived only
 * because they are soft-deleted, and the rule configuration was gone for good.
 */
function backup(reason) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name  = `${stamp}-${String(reason || 'change').replace(/[^a-z0-9_-]/gi, '')}.json`;
    fs.writeFileSync(
      path.join(BACKUP_DIR, name),
      JSON.stringify({ savedAt: new Date().toISOString(), reason, rules: _rules, pending: _pending }, null, 2)
    );

    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
    return name;
  } catch (err) {
    console.error(`[Forward] Backup failed (${reason}): ${err.message}`);
    return null;
  }
}

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort().reverse()
      .map((f) => {
        const d = _read(path.join(BACKUP_DIR, f), {});
        return { file: f, savedAt: d.savedAt || null, reason: d.reason || '',
                 rules: (d.rules || []).length, pending: (d.pending || []).length };
      });
  } catch (err) {
    return [];
  }
}

function restoreBackup(file) {
  if (!/^[\w.\-:]+\.json$/.test(file)) throw new Error('Invalid backup name');
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) throw new Error('Backup not found');

  backup('before-restore');            // the restore is itself destructive
  const data = _read(full, null);
  if (!data) throw new Error('Backup unreadable');

  _rules   = data.rules   || [];
  _pending = data.pending || [];
  _saveRules();
  _savePending();
  return { rules: _rules.length, pending: _pending.length };
}

function _saveRules()   { _write(RULES_PATH,   { rules: _rules }); }
function _savePending() { _write(PENDING_PATH, { pending: _pending }); }
function _saveSeen()    { _write(SEEN_PATH,    { ids: _seen.slice(-SEEN_CAP) }); }

// ── Time helpers ──────────────────────────────────────────────────────────────
/**
 * Wall-clock minutes and weekday in the rule's timezone. The server runs UTC,
 * so a 04:00-05:00 IST window is the previous UTC day — reading the raw Date
 * getters would put it on the wrong day and the wrong hour.
 */
function _localParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const days  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: days[parts.weekday],
  };
}

function _toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** Windows may wrap midnight (e.g. 23:00-01:00). */
function _inWindow(rule, date = new Date()) {
  const tz    = rule.timezone || 'Asia/Kolkata';
  const start = _toMinutes(rule.windowStart);
  const end   = _toMinutes(rule.windowEnd);
  const { minutes, weekday } = _localParts(date, tz);

  if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(weekday)) return false;
  if (start === null || end === null) return true;            // no window = always
  return start <= end ? (minutes >= start && minutes <= end)
                      : (minutes >= start || minutes <= end); // wraps midnight
}

// ── Matching ──────────────────────────────────────────────────────────────────
const LINK_RE = /https?:\/\/\S+/i;

/** Pure: does this message satisfy the rule's content filters? */
function messageMatches(rule, msg) {
  const body = String(msg.body || '');

  if (rule.requireLink && !LINK_RE.test(body)) return false;

  const keywords = (rule.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return true;

  const hay = body.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

/** Pure: is this message inside the rule's window, by its own timestamp? */
function timestampInWindow(rule, tsSeconds) {
  return _inWindow(rule, new Date(tsSeconds * 1000));
}

// ── Rules API ─────────────────────────────────────────────────────────────────
function list()      { return _rules.map((r) => ({ ...r })); }
function listPending(){ return _pending.map((p) => ({ ...p })); }

function create(data) {
  const rule = {
    id:            Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label:         (data.label || '').trim() || 'Untitled rule',
    sourceGroupId: String(data.sourceGroupId || '').trim(),
    windowStart:   data.windowStart || null,
    windowEnd:     data.windowEnd   || null,
    days:          Array.isArray(data.days) ? data.days : [],
    timezone:      data.timezone || 'Asia/Kolkata',
    keywords:      Array.isArray(data.keywords) ? data.keywords : [],
    requireLink:   !!data.requireLink,
    targetType:    data.targetType === 'chat' ? 'chat' : 'sheetGroup',
    targetSheetGroup: data.targetSheetGroup || '',
    targetChatId:  String(data.targetChatId || '').trim(),
    prefix:        data.prefix || '',
    suffix:        data.suffix || '',
    mode:          data.mode === 'auto' ? 'auto' : 'approve',
    pollMinutes:   Math.max(1, Number(data.pollMinutes) || 5),
    active:        false,          // never live on creation
    createdAt:     new Date().toISOString(),
    lastPollAt:    null,
    lastMatchAt:   null,
  };
  if (!rule.sourceGroupId) throw new Error('sourceGroupId is required');
  // A rule with no target would, at delivery time, either throw or fall back to
  // whatever happened to be first. Refuse it here instead.
  if (rule.targetType === 'chat' && !rule.targetChatId) {
    throw new Error('targetChatId is required when targetType is "chat"');
  }
  if (rule.targetType === 'sheetGroup' && !rule.targetSheetGroup) {
    throw new Error('targetSheetGroup is required when targetType is "sheetGroup"');
  }
  _rules.push(rule);
  _saveRules();
  return rule;
}

function update(id, data) {
  const r = _rules.find((x) => x.id === id);
  if (!r) throw new Error('Rule not found');
  const fields = ['label','sourceGroupId','windowStart','windowEnd','days','timezone',
                  'keywords','requireLink','targetType','targetSheetGroup','targetChatId',
                  'prefix','suffix','mode','pollMinutes','active'];
  for (const f of fields) if (data[f] !== undefined) r[f] = data[f];
  if (r.pollMinutes) r.pollMinutes = Math.max(1, Number(r.pollMinutes) || 5);
  _saveRules();
  return r;
}

function remove(id) {
  const rule = _rules.find((x) => x.id === id);
  if (!rule) throw new Error('Rule not found');

  const file = backup(`delete-rule`);
  _rules = _rules.filter((x) => x.id !== id);
  _saveRules();
  console.log(`[Forward] Deleted rule "${rule.label}" (backup: ${file})`);
  return { deleted: rule, backup: file };
}

// ── Polling ───────────────────────────────────────────────────────────────────
function _dueForPoll(rule, now) {
  if (!rule.active) return false;
  if (!_inWindow(rule, now)) return false;        // only poll while the window is open
  if (!rule.lastPollAt) return true;
  return now - new Date(rule.lastPollAt).getTime() >= rule.pollMinutes * 60 * 1000;
}

/**
 * @param range {fromSec, toSec} — which messages to consider at all, separate
 *   from the rule's time-of-day window. Without it a check would happily match
 *   a message from last Tuesday that happened to fall in the 04:00-05:00 window.
 */
async function _pollRule(rule, range = null) {
  const waId = toWAId(rule.sourceGroupId);
  if (!waId) throw new Error(`Rule "${rule.label}": invalid source id`);

  const chat = await chatIndex.findChat(waId);
  if (!chat) throw new Error(`Rule "${rule.label}": source chat not found`);

  const msgs = await chat.fetchMessages({ limit: FETCH_LIMIT });
  const out  = [];

  for (const m of msgs) {
    const id = m.id?._serialized || m.id?.$1;
    if (!id || _seen.includes(id)) continue;
    if (m.fromMe) continue;                       // never forward our own sends
    if (range && (m.timestamp < range.fromSec || m.timestamp > range.toSec)) continue;
    if (!timestampInWindow(rule, m.timestamp)) continue;
    if (!messageMatches(rule, m)) continue;

    _seen.push(id);
    if (m.hasMedia) _msgObjects.set(id, m);
    out.push({
      id:        `${rule.id}:${id}`,
      ruleId:    rule.id,
      ruleLabel: rule.label,
      messageId: id,
      body:      m.body || '',
      hasMedia:  !!m.hasMedia,
      author:    (m.author || m.from || '').replace(/@.*$/, ''),
      timestamp: m.timestamp,
      matchedAt: new Date().toISOString(),
      status:    'pending',
    });
  }

  if (out.length) {
    _seen = _seen.slice(-SEEN_CAP);
    _saveSeen();
    rule.lastMatchAt = new Date().toISOString();
  }
  return out;
}

async function tick() {
  if (_backoff > 0) { _backoff--; return; }
  if (Date.now() - _startedAt < SETTLE_MS) return;   // let a fresh client settle
  if (wa.getState() !== 'ready') return;

  const now = Date.now();
  const due = _rules.filter((r) => _dueForPoll(r, now));
  if (!due.length) return;

  for (const rule of due) {
    try {
      // Only look at messages since the last poll. On the very first poll after
      // a rule is switched on, look back one hour and no further: without this
      // an old message still sitting in the fetch would be forwarded the moment
      // the rule goes live, because nothing is in the dedupe list yet.
      const sinceMs = rule.lastPollAt
        ? new Date(rule.lastPollAt).getTime() - 2 * 60 * 1000   // small overlap
        : Date.now() - 60 * 60 * 1000;
      const matches = await _pollRule(rule, {
        fromSec: Math.floor(sinceMs / 1000),
        toSec:   Infinity,
      });
      rule.lastPollAt = new Date().toISOString();

      for (const match of matches) {
        if (rule.mode === 'auto') {
          try {
            const result = await deliver(match, rule);
            match.status = 'sent';
            match.result = result;
            console.log(`[Forward] Auto-sent "${rule.label}" to ${result.sent} recipient(s)`);
          } catch (err) {
            match.status = 'failed';
            match.error  = err.message;
            console.error(`[Forward] Auto-send failed for "${rule.label}": ${err.message}`);
          }
        } else {
          console.log(`[Forward] "${rule.label}" matched a message — awaiting approval`);
        }
        _pending.push(match);
      }
      if (matches.length) _savePending();
    } catch (err) {
      // A failed poll usually means the page is unhappy; stop hammering it.
      _backoff = BACKOFF_TICKS;
      rule.lastPollAt = new Date().toISOString();
      console.warn(`[Forward] Poll failed (${err.message}) — backing off ${BACKOFF_TICKS} ticks`);
    }
  }
  _saveRules();
}

// ── Delivery ──────────────────────────────────────────────────────────────────
async function _recipients(rule) {
  if (rule.targetType === 'chat') {
    const id = toWAId(rule.targetChatId);
    if (!id) throw new Error('Rule has no valid target chat');
    return [{ name: '', phone: rule.targetChatId, waId: id }];
  }
  const groups = await sheets.fetchGroups(false);
  const group  = groups.find((g) => g.name === rule.targetSheetGroup);
  if (!group) throw new Error(`Target group "${rule.targetSheetGroup}" not found`);
  return group.members
    .map((m) => ({ name: m.name, phone: m.phone, waId: toWAId(m.phone) }))
    .filter((m) => m.waId);
}

/** Send one matched message out. Shared by auto mode and manual approval. */
async function deliver(match, rule) {
  await wa.assertConnected();

  const client  = wa.getClient();
  const members = await _recipients(rule);
  if (!members.length) throw new Error('No recipients');

  let media = null;
  if (match.hasMedia) {
    const msg = _msgObjects.get(match.messageId);
    if (msg) {
      try {
        const dl = await msg.downloadMedia();
        if (dl) media = new MessageMedia(dl.mimetype, dl.data, dl.filename || 'file');
      } catch (err) {
        console.warn(`[Forward] Media download failed: ${err.message}`);
      }
    }
  }

  const now = new Date();
  const results = [];
  for (const member of members) {
    const body = [rule.prefix, match.body, rule.suffix]
      .map((part) => resolveTemplates(part || '', now, member.name || ''))
      .filter((part) => part.trim())
      .join('\n');
    try {
      if (media) await client.sendMessage(member.waId, media, { caption: body || '' });
      else       await client.sendMessage(member.waId, body);
      results.push({ phone: member.phone, ok: true });
    } catch (err) {
      results.push({ phone: member.phone, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 500));   // same pacing as manual forward
  }

  return {
    sent:   results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    mediaIncluded: !!media,
    mediaExpected: !!match.hasMedia,
    results,
  };
}

async function approve(pendingId) {
  const match = _pending.find((p) => p.id === pendingId);
  if (!match) throw new Error('Pending item not found');
  if (match.status === 'sent') throw new Error('Already sent');

  const rule = _rules.find((r) => r.id === match.ruleId);
  if (!rule) throw new Error('Rule no longer exists');

  const result = await deliver(match, rule);
  match.status     = 'sent';
  match.result     = result;
  match.approvedAt = new Date().toISOString();
  _savePending();
  return result;
}

function dismiss(pendingId) {
  const match = _pending.find((p) => p.id === pendingId);
  if (!match) throw new Error('Pending item not found');
  backup('dismiss-pending');
  match.status      = 'dismissed';
  match.dismissedAt = new Date().toISOString();
  _savePending();
  return match;
}

/**
 * Manual "check now" — ignores the poll interval and takes an explicit date
 * range (today, yesterday, last 7 days …) chosen in the UI. The rule's
 * time-of-day window still applies on top of it.
 */
async function checkNow(ruleId, range = null) {
  const rule = _rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error('Rule not found');

  const matches = await _pollRule(rule, range);
  rule.lastPollAt = new Date().toISOString();
  _saveRules();

  for (const m of matches) _pending.push(m);
  if (matches.length) _savePending();
  return matches;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function init() {
  _rules   = _read(RULES_PATH,   { rules: [] }).rules     || [];
  _pending = _read(PENDING_PATH, { pending: [] }).pending || [];
  _seen    = _read(SEEN_PATH,    { ids: [] }).ids         || [];
  _startedAt = Date.now();

  const active = _rules.filter((r) => r.active).length;
  console.log(`[Forward] ${_rules.length} rules loaded, ${active} active, ${_pending.filter((p) => p.status === 'pending').length} awaiting approval`);

  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => { tick().catch((e) => console.error('[Forward] tick:', e.message)); }, TICK_MS);
}

module.exports = {
  init, list, create, update, remove,
  backup, listBackups, restoreBackup,
  listPending, approve, dismiss, checkNow, deliver, tick,
  // exported for tests
  messageMatches, timestampInWindow, _inWindow,
};
