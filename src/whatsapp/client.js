'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const AUTH_PATH = path.join(__dirname, '../../.wwebjs_auth');

/**
 * Remove stale Chrome Singleton* lock files left behind by an unclean crash.
 * whatsapp-web.js/Puppeteer refuses to launch a new browser if these exist,
 * even when no Chrome process is actually running (e.g. after a PM2/OOM kill
 * or the "Navigating frame was detached" crash). Only removes them when no
 * Chrome process currently has the session directory open, so a genuinely
 * running browser is never disturbed.
 */
function _cleanStaleSingletonLocks() {
  const sessionDir = path.join(AUTH_PATH, 'session');
  if (!fs.existsSync(sessionDir)) return;

  let chromeRunning = false;
  try {
    execSync(`pgrep -f "${sessionDir}"`, { stdio: 'ignore' });
    chromeRunning = true; // pgrep exit 0 = a matching process was found
  } catch (_) {
    chromeRunning = false; // pgrep exit 1 = no match
  }

  if (chromeRunning) {
    console.log('[WA] Chrome process still using session dir — skipping lock cleanup');
    return;
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(sessionDir, name);
    try {
      fs.unlinkSync(p);
      console.log(`[WA] Removed stale lock file: ${name}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[WA] Could not remove lock file ${name}: ${err.message}`);
      }
    }
  }
}

// ── State ────────────────────────────────────────────────────────────────────
let _io = null;
let _client = null;
let _state = 'stopped';   // stopped | initializing | qr | ready | disconnected
let _qr = null;           // data URL string, null otherwise
let _startLock = null;    // Promise while start() is running — prevents re-entry
let _reconnectTimer = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ── Public API ────────────────────────────────────────────────────────────────
function setIO(io) { _io = io; }
function getState() { return _state; }
function getQR() { return _qr; }
function getClient() { return _client; }

/** Start (or restart) the WhatsApp client. Safe to call multiple times. */
async function start() {
  _installAuthLockGuard();

  if (_startLock) {
    console.log('[WA] start() called while already starting — waiting');
    return _startLock;
  }
  _startLock = _doStart().finally(() => { _startLock = null; });
  return _startLock;
}

/** Log out, wipe local session files, and start fresh. */
async function clearSession() {
  console.log('[WA] Clearing session');
  _cancelReconnect();

  if (_client) {
    try { await _withTimeout(_client.logout(), 8000); } catch (_) {}
    try { await _withTimeout(_client.destroy(), 8000); } catch (_) {}
    _client = null;
  }

  _removeAuthFiles();

  _setState('stopped', null);
  _reconnectAttempts = 0;
  setTimeout(() => start(), 1000);
}

/**
 * Re-initialize the client WITHOUT logging out or deleting session files.
 * This is what the "Reconnect" button calls — it must never cost the user
 * their pairing. Use clearSession() when the session really should be wiped.
 */
async function reconnect() {
  console.log('[WA] Reconnecting (session preserved)');
  _cancelReconnect();

  if (_client) {
    try { await _withTimeout(_client.destroy(), 8000); } catch (_) {}
    _client = null;
  }

  _reconnectAttempts = 0;
  _setState('stopped', null);   // clears 'ready' so _doStart() won't skip
  return start();
}

// ── Windows logout-crash guard ────────────────────────────────────────────────
/**
 * When WhatsApp ends a session it emits LOGOUT, and whatsapp-web.js responds by
 * deleting the session directory from inside its own async handler. On Windows
 * Chrome can still hold files in there (CrashpadMetrics-active.pma in
 * particular), so that unlink throws EBUSY/EPERM — an unhandled rejection the
 * library never catches, which takes the whole process down. Linux does not hit
 * this because an open file can be unlinked.
 *
 * Recognise exactly that failure and recover from it; anything else is rethrown
 * so genuine bugs still crash loudly.
 */
function _isAuthFileLockError(err) {
  const msg = String((err && err.message) || err || '');
  return (msg.includes('EBUSY') || msg.includes('EPERM')) && msg.includes('.wwebjs_auth');
}

/** Delete the session directory, tolerating Windows file locks. */
function _removeAuthFiles() {
  if (!fs.existsSync(AUTH_PATH)) return true;
  try {
    // maxRetries/retryDelay make Node itself retry EBUSY/EPERM on Windows.
    fs.rmSync(AUTH_PATH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log('[WA] Auth files deleted');
    return true;
  } catch (err) {
    console.warn(`[WA] Could not delete auth files: ${err.message}`);
    return false;
  }
}

let _lockGuardInstalled = false;
function _installAuthLockGuard() {
  if (_lockGuardInstalled) return;
  _lockGuardInstalled = true;

  process.on('unhandledRejection', (err) => {
    if (!_isAuthFileLockError(err)) throw err;   // preserve default crash behaviour
    console.warn('[WA] Session files were locked during logout cleanup — recovering instead of exiting');
    _recoverFromLockedLogout();
  });
}

/** Finish the cleanup the library could not, then start a fresh client. */
async function _recoverFromLockedLogout() {
  _cancelReconnect();

  if (_client) {
    try { await _withTimeout(_client.destroy(), 8000); } catch (_) {}
    _client = null;
  }

  // Chrome exits a moment after destroy(); give it that before retrying.
  setTimeout(() => {
    _removeAuthFiles();
    _setState('stopped', null);
    _reconnectAttempts = 0;
    setTimeout(() => start(), 1000);
  }, 2000);
}

// ── Internal ──────────────────────────────────────────────────────────────────
async function _doStart() {
  _cleanStaleSingletonLocks();

  if (_state === 'ready') {
    console.log('[WA] Already ready, skipping start');
    return;
  }

  _cancelReconnect();

  // Destroy any existing instance first — prevents the
  // "onQRChangedEvent already exists" crash on re-initialization
  if (_client) {
    console.log('[WA] Destroying old client instance');
    try { await _withTimeout(_client.destroy(), 10000); } catch (_) {}
    _client = null;
  }

  _setState('initializing', null);
  console.log('[WA] Creating new client instance');

  _client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    webVersion: process.env.WWEBJS_WEB_VERSION || '2.3000.1036930770-alpha',
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--mute-audio',
      ],
    },
  });

  _attachEvents(_client);

  try {
    await _client.initialize();

    // Fallback: whatsapp-web.js sometimes emits 'authenticated' but never 'ready'.
    // Poll the WA state at 15 s and 45 s after initialize() resolves.
    // If state is CONNECTED but our internal state is still 'initializing', force ready.
    _scheduleFallbackReady(15000);
    _scheduleFallbackReady(45000);
  } catch (err) {
    console.error('[WA] initialize() error:', err.message);
    _setState('stopped', null);
    _scheduleReconnect();
  }
}

function _scheduleFallbackReady(delayMs) {
  setTimeout(async () => {
    if (_state !== 'initializing' || !_client) return;
    try {
      const waState = await _client.getState();
      if (waState === 'CONNECTED') {
        console.warn('[WA] Fallback: ready event never fired but CONNECTED — forcing ready');
        _setState('ready', null);
      }
    } catch (_) {}
  }, delayMs);
}

function _attachEvents(c) {
  c.on('qr', async (rawQR) => {
    console.log('[WA] QR received');
    try {
      const dataUrl = await QRCode.toDataURL(rawQR, { width: 300 });
      _setState('qr', dataUrl);
    } catch (err) {
      console.error('[WA] QR render error:', err.message);
    }
  });

  c.on('authenticated', () => {
    console.log('[WA] Authenticated — session saved');
    _qr = null;
  });

  c.on('ready', () => {
    console.log('[WA] Client ready');
    _reconnectAttempts = 0;
    _setState('ready', null);
  });

  c.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure:', msg);
    _setState('stopped', null);
    _scheduleReconnect();
  });

  c.on('disconnected', (reason) => {
    console.warn('[WA] Disconnected:', reason);
    _setState('disconnected', null);
    _scheduleReconnect();
  });

  // Forward message events + process attendance
  c.on('message', (msg) => {
    const serialized = _serializeMessage(msg);
    if (_io) _io.emit('wa:message', serialized);

    // Only process group messages for attendance
    if (!serialized.isGroupMsg) return;

    // Lazy-require to avoid circular dependency at module load time
    try {
      const attendance = require('../services/attendance');
      const sheets     = require('../services/sheets');

      // Resolve which group name this WA group maps to
      const groups = sheets.fetchGroups(false);   // returns Promise
      Promise.resolve(groups).then((gList) => {
        // We only have the WA group ID here; match it against the active chats later.
        // For now, look up by matching groupName via the client's chat list (cached).
        _resolveGroupName(msg.from).then((groupName) => {
          if (!groupName) return;

          // Strip @c.us from author to get raw phone
          const senderPhone = (msg.author || '').replace(/@c\.us$/, '');
          // Try to find member name from sheets
          const groupData   = gList.find((g) => g.name === groupName);
          const member      = groupData?.members.find((m) => m.phone === senderPhone);

          const record = attendance.processMessage({
            groupName,
            senderPhone,
            senderName:  member?.name || senderPhone,
            body:        msg.body,
            timestamp:   msg.timestamp,
          });

          if (record && _io) {
            _io.emit('attendance:new', record);
          }
        });
      });
    } catch (_) {}
  });
}

function _setState(state, qr) {
  _state = state;
  _qr = qr;
  console.log(`[WA] State → ${state}`);
  _broadcast('wa:status', { state, qr });
}

function _broadcast(event, data) {
  if (_io) _io.emit(event, data);
}

function _scheduleReconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[WA] Max reconnect attempts reached. Restart the app manually.');
    return;
  }
  _reconnectAttempts++;
  // Exponential backoff: 10s, 20s, 40s … capped at 5 min
  const delay = Math.min(10000 * Math.pow(2, _reconnectAttempts - 1), 300000);
  console.log(`[WA] Reconnect attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);
  _reconnectTimer = setTimeout(() => start(), delay);
}

function _cancelReconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

function _serializeMessage(msg) {
  return {
    id: msg.id?.id,
    from: msg.from,
    to: msg.to,
    body: msg.body,
    type: msg.type,
    timestamp: msg.timestamp,
    author: msg.author,
    isGroupMsg: msg.from?.endsWith('@g.us') ?? false,
  };
}

// Cache: WA group ID → sheet group name (refreshed when stale)
let _groupNameCache    = new Map();
let _groupNameCachedAt = 0;

async function _resolveGroupName(waGroupId) {
  // Refresh cache every 5 minutes
  if (Date.now() - _groupNameCachedAt > 5 * 60 * 1000) {
    try {
      const chats  = await Promise.race([
        _client.getChats(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000)),
      ]);
      const sheets = require('../services/sheets');
      const groups = await sheets.fetchGroups(false);
      const waGroups = chats.filter((c) => c.isGroup);

      _groupNameCache = new Map();
      for (const sg of groups) {
        const lower = sg.name.toLowerCase();
        const match = waGroups.find(
          (wg) =>
            wg.name.toLowerCase() === lower ||
            wg.name.toLowerCase().includes(lower) ||
            lower.includes(wg.name.toLowerCase())
        );
        if (match) _groupNameCache.set(match.id._serialized, sg.name);
      }
      _groupNameCachedAt = Date.now();
    } catch (_) {}
  }
  return _groupNameCache.get(waGroupId) || null;
}

module.exports = { setIO, start, reconnect, clearSession, getState, getQR, getClient };
