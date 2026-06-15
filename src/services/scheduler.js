'use strict';

const cron                 = require('node-cron');
const fs                   = require('fs');
const path                 = require('path');
const { MessageMedia }     = require('whatsapp-web.js');
const { resolveTemplates } = require('../utils/templates');

const STORE_PATH = path.join(__dirname, '../../data/schedules.json');
const TIMEZONE   = process.env.SCHEDULE_TIMEZONE || 'Asia/Kolkata';

const _jobs      = new Map();   // id → ScheduledTask
let   _schedules = [];

// ── Boot ──────────────────────────────────────────────────────────────────────
function init() {
  _load();
  let started = 0;
  _schedules.filter((s) => s.active).forEach((s) => { _startJob(s); started++; });
  console.log(`[Scheduler] ${_schedules.length} schedules loaded, ${started} running`);
}

// ── Public API ────────────────────────────────────────────────────────────────
function getAll() {
  return _schedules.map((s) => _withNextRun(s));
}

function create(data) {
  _validateInput(data);
  const cronExpr = _buildCron(data.scheduleType, data.time, data.days, data.dayOfMonth, data.date);

  // Normalize: always store groupNames as array; keep groupName for backward compat
  const groupNames = Array.isArray(data.groupNames) && data.groupNames.length
    ? data.groupNames
    : (data.groupName ? [data.groupName] : []);

  const schedule = {
    id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    groupName:    groupNames[0] || '',   // first group (legacy / display)
    groupNames,
    label:        (data.label || '').trim(),
    text:         (data.text  || '').trim(),
    media:        data.media  || null,    // { base64, mimetype, filename }
    memberPhones: Array.isArray(data.memberPhones) && data.memberPhones.length ? data.memberPhones : null,
    scheduleType: data.scheduleType,      // once | daily | weekly | monthly
    time:         data.time,              // "HH:MM"
    date:         data.date   || null,    // once: "YYYY-MM-DD"
    days:         data.days      || [],   // weekly: array of 0-6
    dayOfMonth:   data.dayOfMonth || 1,  // monthly: 1-31
    cronExpr,
    active:       true,
    createdAt:    new Date().toISOString(),
    lastRun:      null,
  };

  _schedules.push(schedule);
  _save();
  _startJob(schedule);
  return _withNextRun(schedule);
}

function update(id, data) {
  const s = _find(id);
  _stopJob(id);

  if (data.groupName)    s.groupName    = data.groupName;
  if (data.label  !== undefined) s.label = data.label;
  if (data.text   !== undefined) s.text  = data.text;
  if (data.media  !== undefined) s.media = data.media;
  if (data.scheduleType)       s.scheduleType = data.scheduleType;
  if (data.time)               s.time         = data.time;
  if (data.date !== undefined) s.date         = data.date;
  if (data.days)               s.days         = data.days;
  if (data.dayOfMonth)         s.dayOfMonth   = data.dayOfMonth;

  s.cronExpr = _buildCron(s.scheduleType, s.time, s.days, s.dayOfMonth, s.date);
  _save();
  if (s.active) _startJob(s);
  return _withNextRun(s);
}

function toggle(id) {
  const s = _find(id);
  s.active = !s.active;
  s.active ? _startJob(s) : _stopJob(id);
  _save();
  return _withNextRun(s);
}

function remove(id) {
  _stopJob(id);
  _schedules = _schedules.filter((s) => s.id !== id);
  _save();
}

// ── Job execution ─────────────────────────────────────────────────────────────
async function _execute(id) {
  const schedule = _schedules.find((s) => s.id === id);
  if (!schedule || !schedule.active) return;

  const groupLabel = schedule.groupNames?.length > 1
    ? schedule.groupNames.join(', ')
    : (schedule.groupName || schedule.groupNames?.[0] || '?');
  const label = schedule.label || `${groupLabel} (${schedule.scheduleType})`;
  console.log(`[Scheduler] ▶ Firing: ${label}`);

  const wa = require('../whatsapp/client');
  if (wa.getState() !== 'ready') {
    console.warn(`[Scheduler] WhatsApp not ready — skipped: ${label}`);
    return;
  }

  try {
    const sheets = require('./sheets');
    const groups = await sheets.fetchGroups(false);

    // Support groupNames array (new) or single groupName (legacy)
    const names = schedule.groupNames?.length ? schedule.groupNames : [schedule.groupName];

    // Merge and dedupe members from all target groups
    const seen = new Set();
    let allMembers = [];
    for (const name of names) {
      const group = groups.find((g) => g.name === name);
      if (!group) { console.error(`[Scheduler] Group "${name}" not found — skipping`); continue; }
      for (const m of group.members) {
        if (!seen.has(m.phone)) { seen.add(m.phone); allMembers.push(m); }
      }
    }

    if (!allMembers.length) {
      console.error(`[Scheduler] No members found in groups [${names.join(', ')}] — skipped`);
      return;
    }

    const members = schedule.memberPhones
      ? allMembers.filter((m) => schedule.memberPhones.includes(m.phone))
      : allMembers;

    if (!members.length) {
      console.warn(`[Scheduler] No matching recipients for schedule "${label}" — skipped`);
      return;
    }

    const client = wa.getClient();
    const now    = new Date();
    let sent = 0, failed = 0;

    for (const member of members) {
      const waId = _toWAId(member.phone);
      if (!waId) { failed++; continue; }
      const resolvedText = resolveTemplates(schedule.text, now, member.name || '');
      try {
        if (schedule.media) {
          const media = new MessageMedia(
            schedule.media.mimetype,
            schedule.media.base64,
            schedule.media.filename || 'attachment'
          );
          await client.sendMessage(waId, media, { caption: resolvedText || '' });
        } else {
          await client.sendMessage(waId, resolvedText);
        }
        sent++;
      } catch (err) {
        console.warn(`[Scheduler] Failed to send to ${member.phone}:`, err.message);
        failed++;
      }
      await new Promise((r) => setTimeout(r, 500)); // rate limit
    }

    schedule.lastRun = new Date().toISOString();
    if (schedule.scheduleType === 'once') {
      schedule.active = false;
      _stopJob(id);
    }
    _save();
    console.log(`[Scheduler] ✅ ${label}: sent ${sent}, failed ${failed}`);
  } catch (err) {
    console.error(`[Scheduler] ❌ Error: ${label} —`, err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _startJob(schedule) {
  if (_jobs.has(schedule.id)) return;
  if (!cron.validate(schedule.cronExpr)) {
    console.warn(`[Scheduler] Invalid cron "${schedule.cronExpr}" for id ${schedule.id}`);
    return;
  }
  const task = cron.schedule(schedule.cronExpr, () => _execute(schedule.id), {
    timezone: TIMEZONE,
  });
  _jobs.set(schedule.id, task);
}

function _stopJob(id) {
  const task = _jobs.get(id);
  if (task) { task.stop(); _jobs.delete(id); }
}

function _buildCron(type, time, days = [], dayOfMonth = 1, date = null) {
  const [hStr, mStr] = (time || '09:00').split(':');
  const hh = parseInt(hStr, 10);
  const mm = parseInt(mStr, 10);

  if (type === 'once') {
    if (!date) throw new Error('date is required for once schedule');
    const [, month, dom] = date.split('-').map(Number);
    return `${mm} ${hh} ${dom} ${month} *`;
  }
  if (type === 'daily')   return `${mm} ${hh} * * *`;
  if (type === 'weekly')  return `${mm} ${hh} * * ${(days.length ? days : [1]).join(',')}`;
  if (type === 'monthly') return `${mm} ${hh} ${dayOfMonth} * *`;
  throw new Error(`Unknown schedule type: "${type}"`);
}

function _withNextRun(schedule) {
  return { ...schedule, nextRun: schedule.active ? _nextRun(schedule) : null };
}

function _nextRun(schedule) {
  try {
    const [hh, mm] = (schedule.time || '09:00').split(':').map(Number);
    const now = new Date();

    if (schedule.scheduleType === 'once') {
      if (!schedule.date) return null;
      const runAt = new Date(`${schedule.date}T${schedule.time}:00`);
      return runAt > now ? runAt.toISOString() : null;
    }

    if (schedule.scheduleType === 'daily') {
      const next = new Date(now);
      next.setHours(hh, mm, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    if (schedule.scheduleType === 'weekly') {
      const days = schedule.days?.length ? schedule.days : [1];
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = new Date(now);
        candidate.setDate(now.getDate() + offset);
        candidate.setHours(hh, mm, 0, 0);
        if (days.includes(candidate.getDay()) && candidate > now) {
          return candidate.toISOString();
        }
      }
    }

    if (schedule.scheduleType === 'monthly') {
      const dom = schedule.dayOfMonth || 1;
      const next = new Date(now.getFullYear(), now.getMonth(), dom, hh, mm, 0);
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next.toISOString();
    }
  } catch (_) {}
  return null;
}

function _toWAId(raw) {
  if (!raw) return null;
  const clean = raw.trim().replace(/\s/g, '');
  if (clean.endsWith('@g.us') || clean.endsWith('@c.us')) return clean;
  const digits = clean.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length >= 15 ? `${digits}@g.us` : `${digits}@c.us`;
}

function _validateInput(data) {
  const hasGroup = (Array.isArray(data.groupNames) && data.groupNames.length) || data.groupName;
  if (!hasGroup)          throw new Error('groupName or groupNames is required');
  if (!data.scheduleType) throw new Error('scheduleType is required');
  if (!data.time)         throw new Error('time is required');
  if (!data.text && !data.media) throw new Error('Provide text or media');
  if (data.scheduleType === 'once') {
    if (!data.date) throw new Error('date is required for once schedule');
    const runAt = new Date(`${data.date}T${data.time}:00`);
    if (runAt <= new Date()) throw new Error('Scheduled time must be in the future');
  }
  if (data.scheduleType === 'weekly' && (!data.days || !data.days.length)) {
    throw new Error('Select at least one day for weekly schedule');
  }
}

function _find(id) {
  const s = _schedules.find((s) => s.id === id);
  if (!s) throw new Error(`Schedule "${id}" not found`);
  return s;
}

function _load() {
  try {
    if (!fs.existsSync(STORE_PATH)) { _schedules = []; return; }
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    _schedules = raw.schedules || [];
  } catch (err) {
    console.warn('[Scheduler] Could not load file:', err.message);
    _schedules = [];
  }
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({ schedules: _schedules }, null, 2));
  } catch (err) {
    console.error('[Scheduler] Could not save file:', err.message);
  }
}

module.exports = { init, getAll, create, update, toggle, remove };
