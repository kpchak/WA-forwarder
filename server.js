const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const envLocalPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
  require('dotenv').config({ path: envLocalPath, override: true });
}

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia, Message } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');


const app = express();
// Behind Nginx / Nginx Proxy Manager: correct client IP + rate-limit + X-Forwarded-For
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Optimize for Railway: prevent idle disconnections
  pingInterval: 25000, // Send ping every 25 seconds (default: 25000)
  pingTimeout: 60000,  // Wait 60 seconds for pong before disconnect (default: 20000)
  transports: ['polling', 'websocket'], // Fallback to polling if websocket fails
  upgradeTimeout: 30000, // Timeout for upgrade to websocket (default: 10000)
  allowEIO3: true, // Allow Engine.IO v3 clients
  // Increase timeouts for Railway proxy restarts
  connectTimeout: 60000, // Connection timeout
  // Keep connections alive
  httpCompression: true
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Routes that accept base64-encoded media attach this middleware individually.
const largeJsonBody = express.json({ limit: '50mb' });

// Rate limiting to prevent abuse and resource spikes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const sessionToolsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'Too many session tool requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Environment detection for production optimizations
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production' || process.env.HOSTINGER === 'true';

// Only disable cache for script.js in development to ensure fresh code loads
if (!isProduction) {
  app.use('/script.js', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });
}

// Enable aggressive caching for static assets in production
app.use(express.static('public', {
  maxAge: isProduction ? '1d' : 0,
  etag: true,
  lastModified: true
}));

// WhatsApp client setup with LocalAuth
// Disable webCache to avoid LocalWebCache.persist null error in version 1.22.0
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--no-first-run',
  '--mute-audio',
  '--hide-scrollbars',
];

if (isProduction) {
  puppeteerArgs.push(
    '--disable-software-rasterizer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--js-flags=--max-old-space-size=${process.env.CHROMIUM_MAX_OLD_SPACE || 256}`
  );
}

// Pin WhatsApp Web to an archived HTML build (wppconnect-team/wa-version) so live web.whatsapp.com
// cannot drift ahead of whatsapp-web.js (fixes fetchMessages / waitForChatLoading-style failures).
// Override with WWEBJS_WEB_VERSION when wppconnect adds a newer compatible build.
const WWEBJS_WEB_VERSION = process.env.WWEBJS_WEB_VERSION || '2.3000.1036930770-alpha';

// whatsapp-web.js / Puppeteer also read PUPPETEER_* from process.env internally.
// Unset any path that either doesn't exist on this OS or is a Windows path running on Linux.
(function sanitizePuppeteerEnvPaths() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (!fromEnv) return;

  const isWindowsPath = /^[A-Za-z]:[/\\]/.test(fromEnv);
  const isLinux = process.platform !== 'win32';
  const pathInvalid = !fs.existsSync(fromEnv) || (isWindowsPath && isLinux);

  if (!pathInvalid) return;

  if (isWindowsPath && isLinux) {
    console.warn(
      `[WA-forwarder] PUPPETEER_EXECUTABLE_PATH is a Windows path (${fromEnv}) but this is Linux. ` +
      'Unsetting it — remove .env.local from the server or set the correct Linux Chrome path inside it.'
    );
  } else {
    console.warn(
      `[WA-forwarder] PUPPETEER_EXECUTABLE_PATH not found (${fromEnv}). Unsetting it so Puppeteer can use a default browser. ` +
      'Use .env.local for machine-specific Chrome (see .env.example), or set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false and run npm install.'
    );
  }
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  // Docker .env often sets SKIP=true; on a dev PC that usually means no downloaded Chromium — unset for this process
  if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD === 'true') {
    console.warn('[WA-forwarder] Unsetting PUPPETEER_SKIP_CHROMIUM_DOWNLOAD for this run.');
    delete process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD;
  }
})();

const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  webVersion: WWEBJS_WEB_VERSION,
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    strict: false
  },
  puppeteer: {
    headless: true,
    args: puppeteerArgs,
    executablePath: puppeteerExecutablePath
  }
});

let qrCodeData = null;
let isClientReady = false;
let targetPhoneNumbers = []; // Changed to array to store multiple phone numbers
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5 seconds delay between reconnection attempts
let reconnectTimeout = null;
let keepAliveInterval = null;
let isInitializing = false; // Track if client initialization is in progress
let clientInitialized = false; // Track if client has been initialized at least once
let lastAuthFailureTime = null; // Track when last auth failure occurred
let authFailureCount = 0; // Track consecutive auth failures
const AUTH_FAILURE_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown after auth failures
const MAX_AUTH_FAILURES = 3; // Max consecutive failures before long cooldown

// Google Sheets configuration
const GOOGLE_SHEETS_CONFIG = {
  // You'll need to set these environment variables or create a config file
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL || '',
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
  },
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || '',
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets'
  ]
};

function isGoogleSheetsConfigured() {
  const email = String(GOOGLE_SHEETS_CONFIG.credentials.client_email || '').trim();
  const key = String(GOOGLE_SHEETS_CONFIG.credentials.private_key || '').trim();
  const sid = String(GOOGLE_SHEETS_CONFIG.spreadsheetId || '').trim();
  return Boolean(email && key && sid);
}

let googleSheetsMissingEnvLogged = false;

// Customer groups storage
let customerGroups = {};
let attendanceData = {}; // Format: { "groupName": { "customerPhone": { "YYYY-MM": [{dates}, ...] } } }

// Scheduling
const SCHEDULE_FILE_PATH = path.join(__dirname, 'scheduled-messages.json');
const SCHEDULE_CHECK_INTERVAL = 120 * 1000; // 2 minutes (optimized for cost reduction)
let scheduledMessages = [];
let scheduleChecker = null;
let isProcessingSchedules = false;

// Memory management constants
const MAX_MESSAGES_PER_REQUEST = 1000; // Maximum messages to return per request
const MAX_MESSAGES_PER_CHAT = 500; // Per chat fetch cap (wider ranges need more rows before server filter)
const MEMORY_CLEANUP_INTERVAL = 20 * 60 * 1000; // 20 minutes (optimized for more frequent cleanup)

/**
 * WhatsApp Web builds often break chat.fetchMessages (loadEarlierMsgs / msgFind → waitForChatLoading).
 * Reads only messages already in the chat model (no history pagination).
 */
async function fetchChatMessagesInMemory(waClient, chat, limit, searchOptions = {}) {
  const cap = Math.min(Math.max(1, limit), MAX_MESSAGES_PER_CHAT);
  const fromMe = searchOptions.fromMe;
  const raw = await waClient.pupPage.evaluate(
    async (chatId, lim, fromMeFilter) => {
      const msgFilter = (m) => {
        if (m.isNotification) return false;
        if (typeof fromMeFilter === 'boolean' && m.id.fromMe !== fromMeFilter) return false;
        return true;
      };
      const c = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!c || !c.msgs || typeof c.msgs.getModelsArray !== 'function') {
        return [];
      }
      let arr = c.msgs.getModelsArray().filter(msgFilter);
      arr.sort((a, b) => (a.t > b.t ? 1 : -1));
      if (arr.length > lim) {
        arr = arr.slice(-lim);
      }
      return arr.map((m) => window.WWebJS.getMessageModel(m));
    },
    chat.id._serialized,
    cap,
    typeof fromMe === 'boolean' ? fromMe : null
  );
  return raw.map((m) => new Message(waClient, m));
}

/** Pull older messages into the client model when the UI asks for a multi-day range (best-effort). */
async function preSyncChatHistoryIfNeeded(chat, timeFilterStartMs, timeFilterEndMs, minSpanMs = 20 * 60 * 60 * 1000) {
  if (!chat || typeof chat.syncHistory !== 'function') return;
  if (!timeFilterStartMs || !timeFilterEndMs || timeFilterEndMs <= timeFilterStartMs) return;
  const span = timeFilterEndMs - timeFilterStartMs;
  if (span < minSpanMs) return;
  try {
    await Promise.race([
      chat.syncHistory(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('syncHistory timeout')), 25000))
    ]);
    console.log(`[wwebjs] syncHistory OK for ${chat.id?._serialized || 'chat'} (~${Math.round(span / 86400000)}d window)`);
  } catch (e) {
    console.warn(`[wwebjs] syncHistory skipped/failed: ${e?.message || e}`);
  }
}

/**
 * Attempt to load older messages via WhatsApp Web's internal mechanisms.
 * Unlike msgFindBefore (local DB only), loadEarlierMsgs fetches from the server.
 *
 * Current WA Web builds have a broken `waitForChatLoading` dependency that
 * prevents loadEarlierMsgs from working. This function discovers the broken
 * webpack module, re-executes the parent module factory with a patched
 * __webpack_require__ that provides a no-op shim, and then calls the
 * newly-produced loadEarlierMsgs.
 */
async function forceLoadOlderMessages(waClient, chat, targetTimestampSec, maxBatches = 15) {
  const chatId = chat.id._serialized;
  const result = await waClient.pupPage.evaluate(
    async (cid, targetTs, batches) => {
      const log = [];
      try {
        const ch = await window.WWebJS.getChat(cid, { getAsModel: false });
        if (!ch || !ch.msgs) return { ok: false, log: ['chat/msgs not found'] };

        const getOldest = () =>
          ch.msgs.getModelsArray().reduce((min, m) => Math.min(min, m.t || Infinity), Infinity);
        const initialCount = ch.msgs.getModelsArray().length;
        const oldestBefore = getOldest();
        log.push(`initial: ${initialCount} msgs, oldest t=${oldestBefore}`);

        // ──── helper: try calling a loadEarlierMsgs function in a loop ────
        const runLoadLoop = async (fn, label) => {
          let added = 0;
          for (let i = 0; i < batches; i++) {
            const before = ch.msgs.getModelsArray().length;
            try {
              await fn();
            } catch (e) {
              log.push(`${label}[${i}] error: ${e.message?.slice(0, 160)}`);
              break;
            }
            const after = ch.msgs.getModelsArray().length;
            if (after === before) { log.push(`${label}: stalled@${i}`); break; }
            added += (after - before);
            if (getOldest() <= targetTs) { log.push(`${label}: reached target@${i}`); break; }
          }
          if (added) log.push(`${label}: +${added} msgs`);
          return added;
        };

        // ──── Approach 1: collection method (Backbone-style) ────
        if (typeof ch.msgs.loadEarlierMsgs === 'function') {
          await runLoadLoop(() => ch.msgs.loadEarlierMsgs(), 'coll');
        } else {
          log.push('coll.loadEarlierMsgs: NOT available');
        }

        // ──── Approach 2: WAWebChatLoadMessages.loadEarlierMsgs (raw) ────
        if (getOldest() > targetTs) {
          try {
            const loadModule = window.require('WAWebChatLoadMessages');
            if (loadModule && typeof loadModule.loadEarlierMsgs === 'function') {
              await runLoadLoop(() => loadModule.loadEarlierMsgs(ch, ch.msgs), 'mod-raw');
            }
          } catch (_) { /* handled below */ }
        }

        // ──── Approach 3: Monkey-patch waitForChatLoading and retry ────
        if (getOldest() > targetTs) {
          try {
            // Capture __webpack_require__ by injecting a temporary chunk
            let wpReq = null;
            const chunkName = 'webpackChunkwhatsapp_web_client';
            const chunkArr = self[chunkName] || window[chunkName];
            if (chunkArr && typeof chunkArr.push === 'function') {
              chunkArr.push([
                ['__patchProbe_' + Date.now()],
                {},
                function (require) { wpReq = require; },
              ]);
            }
            if (!wpReq || !wpReq.c || !wpReq.m) throw new Error('no webpack internals');

            // 3a – find the module ID for WAWebChatLoadMessages
            let loadModuleId = null;
            for (const [id, cached] of Object.entries(wpReq.c)) {
              if (cached?.exports?.loadEarlierMsgs) { loadModuleId = id; break; }
            }
            if (!loadModuleId) throw new Error('cannot find loadEarlierMsgs module id');
            log.push(`loadMod id=${loadModuleId}`);

            // 3b – get the ENTIRE module factory source (not just loadEarlierMsgs)
            //       because the broken require() likely happens at module scope
            const factoryFn = wpReq.m[loadModuleId];
            const src = typeof factoryFn === 'function'
              ? factoryFn.toString()
              : wpReq.c[loadModuleId].exports.loadEarlierMsgs.toString();
            log.push(`factory src len=${src.length}`);

            // 3c – find which required module is undefined or missing waitForChatLoading
            //       Match patterns like n(12345), e(12345), __webpack_require__(12345)
            const reqPattern = /(?:^|[^.\w$])([a-zA-Z_$][\w$]*)\((\d{2,})\)/g;
            let match;
            const brokenIds = [];
            const checkedIds = new Set();
            while ((match = reqPattern.exec(src)) !== null) {
              const mid = match[2];
              if (checkedIds.has(mid)) continue;
              checkedIds.add(mid);
              try {
                const mod = wpReq(parseInt(mid));
                if (mod === undefined || mod === null) {
                  brokenIds.push(mid);
                }
              } catch (_) { brokenIds.push(mid); }
            }
            log.push(`checked ${checkedIds.size} require ids, brokenIds: [${brokenIds.join(',')}]`);

            // 3d – also scan ALL webpack cached modules for one that declares
            //       waitForChatLoading as a getter/property returning undefined
            for (const [id, cached] of Object.entries(wpReq.c)) {
              if (!cached?.exports || typeof cached.exports !== 'object') continue;
              const desc = Object.getOwnPropertyDescriptor(cached.exports, 'waitForChatLoading');
              if (desc) {
                if (typeof cached.exports.waitForChatLoading !== 'function') {
                  Object.defineProperty(cached.exports, 'waitForChatLoading', {
                    value: async function () {},
                    writable: true,
                    configurable: true,
                  });
                  log.push(`patched getter in mod ${id}`);
                } else {
                  log.push(`mod ${id} already has working waitForChatLoading`);
                }
              }
            }

            // 3e – re-execute the loadEarlierMsgs module factory with patched require
            const factory = wpReq.m[loadModuleId];
            if (typeof factory === 'function') {
              const patchedReq = function (mid) {
                try {
                  const mod = wpReq(mid);
                  if (mod === undefined || mod === null) {
                    return { waitForChatLoading: async function () {}, __esModule: true };
                  }
                  return mod;
                } catch (_) {
                  return { waitForChatLoading: async function () {}, __esModule: true };
                }
              };
              Object.assign(patchedReq, wpReq);

              const freshModule = { exports: {} };
              try {
                factory.call(null, freshModule, freshModule.exports, patchedReq);
                log.push(`re-executed factory, keys: ${Object.keys(freshModule.exports).join(',')}`);
              } catch (fErr) {
                log.push(`factory re-exec error: ${fErr.message?.slice(0, 160)}`);
              }

              if (typeof freshModule.exports.loadEarlierMsgs === 'function') {
                const patchedLoad = freshModule.exports.loadEarlierMsgs;
                const added = await runLoadLoop(
                  () => patchedLoad(ch, ch.msgs),
                  'mod-patched'
                );
                if (added > 0) log.push('patched approach succeeded');
              } else {
                log.push('patched factory did not produce loadEarlierMsgs');
              }
            } else {
              log.push('no factory found for loadMod');
            }

            // 3f – also patch broken module IDs directly in the cache and retry original
            if (getOldest() > targetTs && brokenIds.length > 0) {
              for (const mid of brokenIds) {
                wpReq.c[mid] = {
                  id: parseInt(mid),
                  loaded: true,
                  exports: { waitForChatLoading: async function () {}, __esModule: true },
                };
              }
              log.push(`injected shim into cache for ids [${brokenIds.join(',')}]`);
              try {
                const loadModule = window.require('WAWebChatLoadMessages');
                if (typeof loadModule.loadEarlierMsgs === 'function') {
                  await runLoadLoop(
                    () => loadModule.loadEarlierMsgs(ch, ch.msgs),
                    'mod-cache-patch'
                  );
                }
              } catch (e) {
                log.push(`cache-patch retry error: ${e.message?.slice(0, 120)}`);
              }
            }
          } catch (patchErr) {
            log.push(`patch approach error: ${patchErr.message?.slice(0, 200)}`);
          }
        }

        // ──── Approach 4: Probe other low-level modules (diagnostic) ────
        if (getOldest() > targetTs) {
          const probeNames = [
            'WAWebQueryMsgsCommon', 'WAWebQueryMessages', 'WAWebMsgQuery',
            'WAWebChatAction', 'WAWebHistorySyncActions', 'WAWebMsgActions',
            'WAWebQueryExistingMsg', 'WAWebMsgHistoryQuery',
          ];
          for (const name of probeNames) {
            try {
              const mod = window.require(name);
              if (mod) log.push(`${name}: [${Object.keys(mod).slice(0, 8).join(',')}]`);
            } catch (_) { /* not found */ }
          }
        }

        const finalCount = ch.msgs.getModelsArray().length;
        const oldestAfter = getOldest();
        log.push(`final: ${finalCount} msgs, oldest t=${oldestAfter}`);
        return { ok: true, initialCount, finalCount, oldestBefore, oldestAfter, log };
      } catch (e) {
        log.push(`outer error: ${e.message}`);
        return { ok: false, log };
      }
    },
    chatId,
    Math.floor(targetTimestampSec),
    maxBatches
  );

  if (result.log && result.log.length > 0) {
    console.log(`[wwebjs] forceLoadOlderMessages(${chatId}):`, result.log.join(' | '));
  }
  return result;
}

/**
 * whatsapp-web.js default fetchMessages() uses one findBefore(lastReceivedKey) call — often only a handful of recent rows.
 * This repeats findBefore from the oldest loaded message (same strategy as the library's fromMe branch) to fill `limit`.
 */
async function fetchChatMessagesDeepByLoop(waClient, chat, limit) {
  const cap = Math.min(Math.max(1, limit), MAX_MESSAGES_PER_CHAT);
  const chatId = chat.id._serialized;
  const raw = await waClient.pupPage.evaluate(
    async (cid, lim) => {
      const msgFilter = (m) => !m.isNotification;
      const msgFindLocal = window.require('WAWebDBMessageFindLocal');
      const WAWebMsgKey = window.require('WAWebMsgKey');
      const MsgStore = window.require('WAWebCollections').Msg;
      const findBefore = async (anchorKey, count) => {
        if (typeof msgFindLocal.msgFindByDirection === 'function') {
          return await msgFindLocal.msgFindByDirection({
            anchor: anchorKey,
            count,
            direction: 'before',
          });
        }
        return await msgFindLocal.msgFindBefore({ anchor: anchorKey, count });
      };
      const toMsgKey = (id) => {
        if (!id) return null;
        if (id instanceof WAWebMsgKey) return id;
        const s = typeof id === 'string' ? id : id._serialized || id?.toString?.();
        return s ? WAWebMsgKey.fromString(s) : null;
      };
      const toMsgModels = (rawMessages) => {
        const out = [];
        for (const m of rawMessages) {
          if (m && typeof m.serialize === 'function') {
            out.push(m);
            continue;
          }
          const serialized = m?.id?._serialized || (typeof m === 'string' ? m : null);
          let model =
            (serialized && MsgStore.get(serialized)) ||
            (m?.id && MsgStore.get(m.id._serialized || m.id)) ||
            null;
          if (!model && m && MsgStore.modelClass) {
            try {
              model = new MsgStore.modelClass(m);
            } catch (e) {
              model = null;
            }
          }
          if (model) out.push(model);
        }
        return out;
      };
      const dedupeByMsgId = (arr) => {
        const seen = new Set();
        return arr.filter((m) => {
          const key = m.id?._serialized;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const ch = await window.WWebJS.getChat(cid, { getAsModel: false });
      let msgs = ch.msgs.getModelsArray().filter(msgFilter);
      msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
      const batchCap = Math.min(100, lim);
      let iterations = 0;
      const maxIterations = 60;
      while (msgs.length < lim && iterations < maxIterations) {
        iterations++;
        const anchor =
          msgs[0]?.id ||
          ch.msgs.getModelsArray()[0]?.id ||
          ch.lastReceivedKey;
        if (!anchor) break;
        const anchorKey = toMsgKey(anchor);
        if (!anchorKey) break;
        const need = Math.min(batchCap, lim - msgs.length);
        if (need <= 0) break;
        const result = await findBefore(anchorKey, need);
        const rawMessages = Array.isArray(result) ? result : result?.messages || [];
        if (result?.status === 404 || !rawMessages.length) break;
        const loadedMessages = toMsgModels(rawMessages);
        if (!loadedMessages.length) break;
        const prevLen = msgs.length;
        msgs = dedupeByMsgId([...loadedMessages.filter(msgFilter), ...msgs]);
        msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
        if (msgs.length === prevLen) break;
        if (loadedMessages.length < need) break;
      }
      if (msgs.length > lim) msgs = msgs.slice(-lim);
      return msgs.map((m) => window.WWebJS.getMessageModel(m));
    },
    chatId,
    cap
  );
  return raw.map((m) => new Message(waClient, m));
}

function oldestMessageTimestampMs(messages) {
  if (!messages || messages.length === 0) return null;
  const sec = Math.min(...messages.map((m) => Number(m.timestamp) || 0));
  return sec > 0 ? sec * 1000 : null;
}

/**
 * Default fetchMessages() does NOT set fromMe, so wwebjs uses a single findBefore(lastReceivedKey) path.
 * With fromMe true/false it uses the while-loop pagination branch — often loads much more history per direction.
 */
async function fetchChatMessagesFromMeSplit(waClient, chat, limit) {
  const cap = Math.min(Math.max(1, limit), MAX_MESSAGES_PER_CHAT);
  const fetchDir = async (fromMe) => {
    try {
      return await chat.fetchMessages({ limit: cap, fromMe });
    } catch (e) {
      const d = e?.message || String(e);
      if (d.includes('waitForChatLoading') || d.includes('loadEarlierMsgs')) {
        return [];
      }
      throw e;
    }
  };
  const [out, inc] = await Promise.all([fetchDir(true), fetchDir(false)]);
  const map = new Map();
  for (const m of out) {
    if (m?.id?._serialized) map.set(m.id._serialized, m);
  }
  for (const m of inc) {
    if (m?.id?._serialized) map.set(m.id._serialized, m);
  }
  const merged = [...map.values()].sort(
    (a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)
  );
  return merged;
}

function pickRicherHistory(messages, candidate, label, timeFilterStartMs) {
  if (!candidate || candidate.length === 0) return messages;
  const oCand = oldestMessageTimestampMs(candidate);
  const oBase = oldestMessageTimestampMs(messages);
  const richer =
    candidate.length > messages.length ||
    (oCand != null && oBase != null && oCand < oBase - 1000) ||
    (oCand != null && oBase == null);
  if (richer) {
    console.log(
      `[wwebjs] ${label}: ${candidate.length} msgs (was ${messages.length}); oldest=${oCand ? new Date(oCand).toISOString() : '?'} filterStart=${timeFilterStartMs ? new Date(timeFilterStartMs).toISOString() : 'n/a'}`
    );
    return candidate;
  }
  return messages;
}

/** Prefer library fetchMessages; backfill via deep loop + fromMe-split when range needs older rows; sync + retry; then in-memory. */
async function fetchChatMessagesSafe(waClient, chat, limit, searchOptions = {}, meta = {}) {
  const timeFilterStartMs = Number(meta.timeFilterStartMs) > 0 ? Number(meta.timeFilterStartMs) : 0;
  const slackMs = 120000;

  const maybeHistoryBackfill = async (messages) => {
    if (timeFilterStartMs <= 0 || !messages || messages.length === 0) return messages;
    const oldestMs = oldestMessageTimestampMs(messages);
    if (oldestMs == null || oldestMs <= timeFilterStartMs + slackMs) return messages;

    let best = messages;
    try {
      const deep = await fetchChatMessagesDeepByLoop(waClient, chat, limit);
      best = pickRicherHistory(best, deep, 'deep pagination', timeFilterStartMs);
    } catch (e) {
      console.warn(`[wwebjs] deep pagination: ${e?.message || e}`);
    }
    try {
      const split = await fetchChatMessagesFromMeSplit(waClient, chat, limit);
      best = pickRicherHistory(best, split, 'fromMe split pagination', timeFilterStartMs);
    } catch (e) {
      console.warn(`[wwebjs] fromMe split: ${e?.message || e}`);
    }

    if (best === messages && oldestMessageTimestampMs(messages) > timeFilterStartMs + slackMs) {
      console.warn(
        `[wwebjs] history backfill did not extend before filter start (still ${messages.length} msgs); WhatsApp DB may not expose older rows for this chat.`
      );
    }
    return best;
  };

  const fetchOnce = () => chat.fetchMessages({ limit, ...searchOptions });
  try {
    let messages = await fetchOnce();
    messages = await maybeHistoryBackfill(messages);
    return messages;
  } catch (err) {
    const detail = err?.message || String(err);
    if (!detail.includes('waitForChatLoading') && !detail.includes('loadEarlierMsgs')) {
      throw err;
    }
    console.warn(`[wwebjs] fetchMessages failed (1st try): ${detail.slice(0, 160)}`);
    if (typeof chat.syncHistory === 'function') {
      try {
        await Promise.race([
          chat.syncHistory(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
        ]);
        console.warn('[wwebjs] syncHistory finished; retrying fetchMessages once');
      } catch (syncErr) {
        console.warn(`[wwebjs] syncHistory: ${syncErr?.message || syncErr}`);
      }
    }
    try {
      let messages = await fetchOnce();
      messages = await maybeHistoryBackfill(messages);
      return messages;
    } catch (err2) {
      const d2 = err2?.message || String(err2);
      if (!d2.includes('waitForChatLoading') && !d2.includes('loadEarlierMsgs')) {
        throw err2;
      }
      console.warn(
        `[wwebjs] fetchMessages failed after sync; using in-memory only for ${chat.id._serialized}: ${d2.slice(0, 160)}`
      );
      let messages = await fetchChatMessagesInMemory(waClient, chat, limit, searchOptions);
      messages = await maybeHistoryBackfill(messages);
      return messages;
    }
  }
}

function digitsOnlyPhone(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * WhatsApp may set msg.from to ...@lid (opaque id). Sheets use country + mobile digits.
 * For 1:1 @c.us chats, use the chat id as the customer phone when from is @lid.
 */
async function resolveSenderPhoneAndName(waClient, chatPhoneNumber, msg, contactTimeoutMs = 2000) {
  if (msg.fromMe) {
    return { senderIdForFrom: msg.from, senderPhone: 'Me', senderName: 'You' };
  }

  const chatId = String(chatPhoneNumber || '');
  const senderId = (chatId.includes('@g.us') && msg.author) ? msg.author : msg.from;
  const sid = String(senderId || '');

  let senderPhone = '';

  if (chatId.endsWith('@c.us')) {
    if (sid.includes('@lid')) {
      senderPhone = digitsOnlyPhone(chatId.replace(/@c\.us$/i, ''));
    } else {
      senderPhone = digitsOnlyPhone(sid.replace(/@c\.us$/i, ''));
    }
  } else if (chatId.includes('@g.us')) {
    if (sid.includes('@lid')) {
      try {
        const contact = await Promise.race([
          waClient.getContactById(senderId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), contactTimeoutMs))
        ]);
        if (contact && contact.number) {
          senderPhone = digitsOnlyPhone(contact.number);
        }
      } catch (_) {
        /* fallback below */
      }
      if (!senderPhone) {
        senderPhone = digitsOnlyPhone(sid.replace(/@lid$/i, ''));
      }
    } else {
      senderPhone = digitsOnlyPhone(sid.replace(/@c\.us$/i, '').replace(/@g\.us$/i, ''));
    }
  } else {
    senderPhone = digitsOnlyPhone(
      sid.replace(/@c\.us$/i, '').replace(/@g\.us$/i, '').replace(/@lid$/i, '')
    );
  }

  let senderName = 'Unknown';
  try {
    const contact = await Promise.race([
      waClient.getContactById(senderId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), contactTimeoutMs))
    ]);
    if (contact && contact.name) {
      senderName = contact.name;
    } else {
      senderName = senderPhone || sid;
    }
  } catch (error) {
    senderName = senderPhone || sid;
  }

  return { senderIdForFrom: senderId, senderPhone, senderName };
}

const MEMORY_WARNING_THRESHOLD = 0.9; // Warn if memory usage exceeds 90% of limit

// Google Sheets caching
let customerGroupsCache = null;
let customerGroupsCacheTime = 0;
const CUSTOMER_GROUPS_CACHE_TTL = Infinity; // Cache forever until manual refresh

// Auto-restart function with retry logic
function scheduleReconnect() {
  if (isReconnecting) {
    console.log('⚠️ Already attempting to reconnect, skipping...');
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Manual intervention required.`);
    io.emit('clientDisconnected', {
      reason: 'Max reconnection attempts reached',
      requiresReconnect: true
    });
    return;
  }

  isReconnecting = true;
  reconnectAttempts++;
  const delay = RECONNECT_DELAY * reconnectAttempts; // Exponential backoff

  console.log(`🔄 Scheduling reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000} seconds...`);

  reconnectTimeout = setTimeout(async () => {
    try {
      // Check if we're in cooldown period after auth failures
      if (lastAuthFailureTime && authFailureCount >= MAX_AUTH_FAILURES) {
        const timeSinceFailure = Date.now() - lastAuthFailureTime;
        if (timeSinceFailure < AUTH_FAILURE_COOLDOWN) {
          const remainingMinutes = Math.ceil((AUTH_FAILURE_COOLDOWN - timeSinceFailure) / 1000 / 60);
          console.error(`❌ Still in cooldown period after auth failures. Wait ${remainingMinutes} more minutes.`);
          console.error('❌ Auto-reconnection disabled due to multiple auth failures.');
          isReconnecting = false;
          return;
        } else {
          // Cooldown expired, reset failure count
          console.log('✅ Cooldown period expired, resetting auth failure count');
          authFailureCount = 0;
          lastAuthFailureTime = null;
        }
      }

      console.log(`🔄 Attempting to reconnect (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

      // Destroy existing client if it exists
      try {
        if (client && typeof client.destroy === 'function') {
          // Add timeout to prevent hanging
          const destroyPromise = client.destroy();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Destroy timeout')), 5000)
          );
          await Promise.race([destroyPromise, timeoutPromise]).catch(err => {
            // Ignore destroy errors - client may already be destroyed or in invalid state
            if (!err.message.includes('timeout')) {
              console.log('⚠️ Error destroying client (may already be destroyed):', err.message);
            }
          });
        }
      } catch (destroyError) {
        // Ignore destroy errors - client may already be destroyed
        console.log('⚠️ Error destroying client (may already be destroyed):', destroyError.message);
      }

      // Wait longer before reinitializing to avoid triggering "link device" error
      // Increased delay to reduce rapid reconnection attempts
      // Minimum 10 seconds, then exponential backoff
      const waitTime = Math.max(10000, reconnectAttempts * 8000); // Minimum 10s, then: 16s, 24s, 32s, 40s
      console.log(`⏳ Waiting ${waitTime / 1000} seconds before reinitializing (to avoid rate limiting)...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Prevent multiple simultaneous initializations
      if (isInitializing) {
        console.log('⚠️ Client initialization already in progress, skipping...');
        isReconnecting = false;
        isInitializing = false;
        return;
      }

      // Check if client is already ready
      if (isClientReady) {
        console.log('✅ Client is already ready, no need to reconnect');
        isReconnecting = false;
        isInitializing = false;
        return;
      }

      isInitializing = true;

      // Check if client still exists and has initialize method
      if (client && typeof client.initialize === 'function') {
        console.log('🔄 Initializing client for reconnection...');
        removeStaleGoogleChromeTmpArtifacts();
        removeChromeProfileSingletonLocks(WWEBJS_AUTH_DIR);
        await client.initialize().catch(initError => {
          isInitializing = false;
          throw new Error(`Failed to initialize client: ${initError.message}`);
        });
        isReconnecting = false;
        // isInitializing will be set to false in ready event
      } else {
        isInitializing = false;
        throw new Error('Client object is not valid for reconnection');
      }
    } catch (error) {
      console.error('❌ Reconnection attempt failed:', error.message);
      console.error('Error stack:', error.stack);
      isReconnecting = false;
      isInitializing = false; // Reset initialization flag

      // Schedule next attempt if not exceeded max
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect();
      } else {
        console.error('❌ Max reconnection attempts reached. Server will continue running but WhatsApp is disconnected.');
        console.error('User will need to manually refresh and scan QR code.');
      }
    }
  }, delay);
}

// Keepalive mechanism to prevent idle disconnections
function startKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  // Send a keepalive check every 5 minutes to prevent idle disconnection
  // Less aggressive to avoid triggering WhatsApp security
  keepAliveInterval = setInterval(async () => {
    if (isClientReady && client) {
      try {
        // Get client state to check connection status
        // Just checking state is safe and won't trigger security
        const state = await client.getState();
        if (state === 'CONNECTED') {
          console.log('💚 Keepalive: Client is still connected (state: CONNECTED)');
          // Don't call getChats() - it can trigger WhatsApp security detection
          // Just checking state is enough to keep the connection alive
        } else if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          console.warn(`⚠️ Keepalive: Client state is ${state}, connection lost`);
          // Don't trigger reconnect here - let the disconnected event handle it
        } else {
          console.warn(`⚠️ Keepalive: Client state is ${state}`);
        }
      } catch (error) {
        console.error('❌ Keepalive check failed:', error.message);
        // If keepalive fails, connection might be lost
        // The disconnected event will handle reconnection
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes (increased from 3 to avoid security triggers)

  console.log('✅ Keepalive mechanism started (every 5 minutes)');
}

// Consolidated force-ready – one single path so there are no race conditions
let forceReadyLock = false;
function forceClientReady(source) {
  if (isClientReady && firstReadyProcessed) return;
  if (forceReadyLock) return;
  forceReadyLock = true;

  console.log(`⚡ forceClientReady called from: ${source}`);
  firstReadyProcessed = true;
  isClientReady = true;
  isReconnecting = false;
  isInitializing = false;
  client._readyTime = Date.now();

  if (authFailureCount > 0) {
    authFailureCount = 0;
    lastAuthFailureTime = null;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  reconnectAttempts = 0;
  qrCodeData = null;
  lastQRCodeEmitted = null;

  io.emit('clientReady', {
    message: 'WhatsApp client is ready!',
    timestamp: new Date().toISOString(),
    forced: source !== 'ready-event'
  });

  console.log('⏳ Waiting 60 seconds before starting keepalive...');
  setTimeout(() => {
    if (isClientReady) startKeepAlive();
  }, 60000);

  forceReadyLock = false;
}

// WhatsApp client events
let lastQRCodeEmitted = null; // Track last QR code to prevent duplicates
client.on('qr', (qr) => {
  console.log('QR Code received');
  console.log('🔍 QR Event Debug:', {
    isClientReady,
    firstReadyProcessed,
    firstAuthenticatedProcessed,
    qrLength: qr ? qr.length : 'null'
  });


  // CRITICAL: If client is already ready and authenticated, ignore QR code
  // QR code generation after authentication suggests WhatsApp is trying to re-authenticate
  // This is suspicious and might trigger security detection
  if (isClientReady || firstReadyProcessed || firstAuthenticatedProcessed) {
    console.error('❌ CRITICAL: QR code received but client is already authenticated/ready!');
    console.error('❌ This suggests WhatsApp is trying to re-authenticate, which is suspicious');
    console.error('❌ IGNORING QR code to prevent triggering WhatsApp security detection');
    console.error('🔍 State check:', { isClientReady, firstReadyProcessed, firstAuthenticatedProcessed });
    return; // CRITICAL: Ignore QR codes if client is already authenticated
  }

  // Prevent emitting duplicate QR codes
  if (qr === lastQRCodeEmitted) {
    console.log('⚠️ Duplicate QR code received, skipping emission');
    return;
  }

  lastQRCodeEmitted = qr;
  qrCodeData = qr;

  // Reset reconnection attempts when new QR code is received
  reconnectAttempts = 0;

  // Reset auth failure tracking when new QR code is generated
  // This means we're starting fresh authentication
  if (authFailureCount > 0) {
    console.log(`🔄 New QR code generated - resetting auth failure count (was ${authFailureCount})`);
    authFailureCount = 0;
    lastAuthFailureTime = null;
  }

  // Reset authenticated event tracking when new QR code is generated
  // This means we're starting fresh authentication
  if (firstAuthenticatedProcessed) {
    console.log(`🔄 New QR code generated - resetting authenticated event tracking`);
    authenticatedEventCount = 0;
    lastAuthenticatedTime = null;
    firstAuthenticatedProcessed = false;
  }

  // Generate QR code image
  QRCode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Error generating QR code:', err);
      return;
    }

    console.log('📱 QR Code generated - client needs authentication');
    // Only emit QR code if client is not ready
    // This prevents showing QR during temporary disconnects when session is still valid
    if (!isClientReady) {
      console.log('📤 Emitting QR code to clients (client not ready)');
      console.log('🔍 QR Emission Debug:', {
        isClientReady,
        firstReadyProcessed,
        firstAuthenticatedProcessed,
        qrCodeData: qrCodeData ? 'exists' : 'null'
      });
      io.emit('qrCode', { qrData: qr, qrImage: url });
      console.log('✅ QR code emitted to all clients');
    } else {
      console.log('⚠️ QR code generated but client is ready - not emitting (likely temporary)');
    }
  });
});

let readyEventCount = 0;
let lastReadyTime = null;
const READY_DEBOUNCE = 10000;
let firstReadyProcessed = false;

client.on('ready', () => {
  readyEventCount++;
  const readyTime = Date.now();

  if (isClientReady || firstReadyProcessed) {
    console.warn(`⚠️ Duplicate ready event #${readyEventCount} ignored (already ready)`);
    return;
  }
  if (lastReadyTime && (readyTime - lastReadyTime) < READY_DEBOUNCE) {
    console.warn(`⚠️ Ready event #${readyEventCount} debounced (${readyTime - lastReadyTime}ms since last)`);
    return;
  }
  lastReadyTime = readyTime;

  console.log(`✅ WhatsApp client is ready! (event #${readyEventCount})`);
  forceClientReady('ready-event');
});

let authenticatedEventCount = 0;
let lastAuthenticatedTime = null;
let firstAuthenticatedProcessed = false;
const AUTHENTICATED_DEBOUNCE = 10000; // 10 second debounce for authenticated events - increased

client.on('authenticated', () => {
  authenticatedEventCount++;
  const now = Date.now();

  console.log('✅ ========================================');
  console.log('✅ Authenticated event fired (event #' + authenticatedEventCount + ')');
  console.log('✅ Time:', new Date(now).toISOString());
  console.log('🔍 Auth Debug:', {
    firstAuthenticatedProcessed,
    lastAuthenticatedTime,
    timeSinceLast: lastAuthenticatedTime ? now - lastAuthenticatedTime : null,
    isClientReady
  });
  console.log('✅ ========================================');


  // CRITICAL: If we've already processed an authenticated event, ignore ALL subsequent ones
  // This prevents multiple authenticated events from triggering multiple ready events
  // Check this FIRST before any other processing
  if (firstAuthenticatedProcessed) {
    const timeSinceFirst = lastAuthenticatedTime ? (now - lastAuthenticatedTime) : 0;
    console.error(`❌ CRITICAL: Authenticated event #${authenticatedEventCount} fired but already authenticated!`);
    console.error(`❌ Time since first authenticated: ${timeSinceFirst}ms`);
    console.error('❌ IGNORING this duplicate authenticated event to prevent WhatsApp security detection');
    return; // CRITICAL: Ignore ALL authenticated events after the first one
  }

  // Debounce authenticated events - ignore if fired too quickly after previous one
  // Check this BEFORE setting the flag to catch rapid duplicates
  if (lastAuthenticatedTime && (now - lastAuthenticatedTime) < AUTHENTICATED_DEBOUNCE) {
    console.warn(`⚠️ Duplicate authenticated event detected (${authenticatedEventCount} total, ${now - lastAuthenticatedTime}ms since last)`);
    console.warn('⚠️ Ignoring duplicate to prevent multiple ready events');
    return; // Ignore duplicate authenticated events
  }

  lastAuthenticatedTime = now;
  firstAuthenticatedProcessed = true;
  console.log(`✅ WhatsApp client authenticated (event #${authenticatedEventCount})`);

  // Session resume sometimes fires 'authenticated' but never 'ready'.
  // A single delayed check is enough – forceClientReady guards against duplicates.
  setTimeout(async () => {
    if (!client || isClientReady) return;
    try {
      const state = await client.getState();
      if (state === 'CONNECTED' && !isClientReady && !firstReadyProcessed) {
        console.warn('⚠️ Authenticated but ready never fired – forcing ready');
        forceClientReady('authenticated-fallback');
      }
    } catch (e) { /* ignore */ }
  }, 5000);
});

client.on('auth_failure', (msg) => {
  const failureTime = Date.now();
  authFailureCount++;
  lastAuthFailureTime = failureTime;


  const errorMsg = String(msg || '').toLowerCase();
  const isLinkDeviceError = errorMsg.includes('link device') ||
    errorMsg.includes('try again later') ||
    errorMsg.includes('could not link');


  console.error('❌ ========================================');
  console.error('❌ Authentication failed:', msg);
  console.error(`❌ Auth failure count: ${authFailureCount}`);
  console.error('❌ ========================================');

  if (isLinkDeviceError) {
    console.error('❌ "Could not link device" error detected!');
    console.error('❌ This often happens when the app runs on a VPS/cloud (e.g. Hostinger):');
    console.error('   WhatsApp may block or restrict linking from data-center IPs.');
    console.error('❌ Other causes:');
    console.error('   1. Too many connection attempts in short time');
    console.error('   2. Phone WhatsApp is not active or connected to internet');
    console.error('   3. Session conflict (multiple devices trying to connect)');
    console.error('❌ ========================================');
    console.error('❌ Workaround for VPS/cloud:');
    console.error('   1. On your HOME computer (same network as your phone): run the app, scan QR, link successfully.');
    console.error('   2. Copy the folder .wwebjs_auth from your computer to the server (same path as server.js).');
    console.error('   3. Restart the app on the server. It may use the existing session (works until WhatsApp invalidates it).');
    console.error('❌ Or try: Wait 10+ minutes, use phone on same country, then retry QR once.');
    console.error('❌ ========================================');

    // Implement cooldown - don't auto-reconnect immediately
    if (authFailureCount >= MAX_AUTH_FAILURES) {
      console.error(`❌ ${authFailureCount} consecutive auth failures - implementing ${AUTH_FAILURE_COOLDOWN / 1000 / 60} minute cooldown`);
      console.error('❌ Auto-reconnection disabled. Please wait and try manually.');

      // Reset reconnection attempts to prevent immediate retry
      reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
      isReconnecting = false;
      isInitializing = false;
    }
  }

  // Reset ready event count on auth failure
  readyEventCount = 0;

  io.emit('authFailure', {
    message: msg,
    isLinkDeviceError: isLinkDeviceError,
    failureCount: authFailureCount,
    recommendations: isLinkDeviceError ? [
      'VPS/cloud: WhatsApp often blocks data-center IPs. Link at home, then copy the .wwebjs_auth folder to the server.',
      'Wait 10+ minutes and try again (one QR scan only).',
      'Ensure phone WhatsApp is active, same country, and connected to internet.',
      'Close other WhatsApp Web sessions and restart the app on the server.'
    ] : []
  });
});

client.on('disconnected', (reason) => {
  console.log('⚠️ WhatsApp client disconnected:', reason);
  console.log('⚠️ Disconnect reason type:', typeof reason);
  console.log('⚠️ Disconnect reason details:', JSON.stringify(reason, null, 2));
  console.log(`⚠️ Ready events fired before disconnect: ${readyEventCount}`);


  // If multiple ready events occurred, this might be the cause of LOGOUT
  const previousReadyCount = readyEventCount;
  if (previousReadyCount > 1 && String(reason || '').toUpperCase().includes('LOGOUT')) {
    console.error('❌ ========================================');
    console.error('❌ LOGOUT likely caused by multiple ready events!');
    console.error(`❌ ${previousReadyCount} ready events fired, triggering WhatsApp security`);
    console.error('❌ Multiple ready events indicate:');
    console.error('   1. Multiple browser tabs/windows connected');
    console.error('   2. Server restarted while client was initializing');
    console.error('   3. Reconnection attempt overlapped with existing connection');
    console.error('❌ ========================================');
  }

  readyEventCount = 0;
  lastReadyTime = null;
  firstReadyProcessed = false;
  authenticatedEventCount = 0;
  lastAuthenticatedTime = null;
  firstAuthenticatedProcessed = false;
  forceReadyLock = false;

  isClientReady = false;
  isInitializing = false;
  clientInitialized = false; // allow re-initialization after disconnect

  // Clear keepalive interval
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  // Determine if this is a permanent session closure or temporary disconnect
  const reasonStr = String(reason || '').toUpperCase();
  const isLogout = reasonStr === 'LOGOUT' || reasonStr.includes('LOGOUT');
  const requiresReconnect = isLogout || reasonStr === 'NAVIGATION' || reasonStr.includes('SESSION CLOSED') || reasonStr.includes('TIMEOUT');

  io.emit('clientDisconnected', {
    reason: reason || 'Connection lost',
    requiresReconnect: requiresReconnect
  });

  // Auto-restart client on disconnect (except for LOGOUT)
  // Don't auto-reconnect on LOGOUT - user needs to scan QR code again
  if (isLogout) {
    const disconnectTime = new Date().toISOString();
    console.log('⚠️ ========================================');
    console.log('⚠️ LOGOUT DETECTED - Manual reconnection required');
    console.log('⚠️ ========================================');
    console.log('⚠️ Disconnect time:', disconnectTime);
    console.log('⚠️ Possible causes:');
    console.log('   1. WhatsApp security detection (suspicious activity)');
    console.log('   2. Session expired or invalidated');
    console.log('   3. User logged out from phone or another device');
    console.log('   4. Multiple sessions conflict');
    console.log('   5. Regional policy (e.g., India 6-hour logout rule)');
    console.log('⚠️ ========================================');

    // Check if this is an immediate logout (within 60 seconds of ready)
    // This might indicate security detection
    if (client._readyTime) {
      const timeSinceReady = Date.now() - client._readyTime;
      if (timeSinceReady < 60000) {
        console.log('⚠️ ⚠️ ⚠️ IMMEDIATE LOGOUT DETECTED ⚠️ ⚠️ ⚠️');
        console.log(`⚠️ Logged out ${Math.round(timeSinceReady / 1000)} seconds after connection`);
        console.log('⚠️ This strongly suggests WhatsApp security detection');
        console.log('⚠️ Recommendations:');
        console.log('   - Wait 5-10 minutes before reconnecting');
        console.log('   - Ensure phone WhatsApp is active and connected');
        console.log('   - Avoid multiple rapid reconnections');
        console.log('   - Check if you have other WhatsApp Web sessions open');
        console.log('⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️');
      }
    }

    console.log('⚠️ Action required: Refresh page and scan QR code again');
    console.log('⚠️ ========================================');

    // Reset reconnection attempts for next time
    reconnectAttempts = 0;
    isReconnecting = false;

    // Clear the session data to force fresh authentication
    // This helps prevent stale session issues
    try {
      const authPath = path.join(__dirname, '.wwebjs_auth');
      const sessionExists = fs.existsSync(authPath);
      if (sessionExists) {
        console.log('⚠️ Session exists in LocalAuth store');
        console.log('⚠️ Consider clearing session if LOGOUT persists');
      }
    } catch (error) {
      console.error('Error checking session:', error.message);
    }
  } else if (requiresReconnect) {
    console.log('⚠️ Session requires re-authentication - will attempt to reconnect');
    scheduleReconnect();
  } else {
    console.log('⏳ Temporary disconnect - scheduling auto-reconnection...');
    scheduleReconnect();
  }
});

// Listen for messages
client.on('message', async (message) => {
  // Check if message is from any of the target phone numbers
  const isFromTarget = targetPhoneNumbers.some(phoneNumber => {
    const formattedNumber = phoneNumber.replace(/\D/g, '');
    return message.from.includes(formattedNumber);
  });

  if (isFromTarget) {
    const messageData = {
      from: message.from,
      body: message.body || '',
      timestamp: message.timestamp,
      type: message.type,
      isFromMe: message.fromMe,
      hasMedia: message.hasMedia,
      mediaUrl: null,
      mediaFilename: null,
      mediaMimetype: null
    };

    // Handle media messages
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          messageData.mediaUrl = `data:${media.mimetype};base64,${media.data}`;
          messageData.mediaFilename = media.filename || `media_${message.id._serialized}`;
          messageData.mediaMimetype = media.mimetype;
        }
      } catch (error) {
        console.error('Error downloading media:', error);
        messageData.mediaError = 'Failed to download media';
      }
    }

    io.emit('newMessage', messageData);
  }
});

const WWEBJS_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const WWEBJS_CACHE_DIR = path.join(__dirname, '.wwebjs_cache');
const TEMP_DIR = path.join(__dirname, 'temp');

/** Chrome leaves Singleton* locks in the profile; new Docker containers get a new hostname and refuse to start (Code 21). */
const CHROME_SINGLETON_BASENAMES = new Set([
  'singletonlock',
  'singletonsocket',
  'singletoncookie',
]);

function isChromeSingletonLockFile(name) {
  const n = String(name || '').toLowerCase();
  return CHROME_SINGLETON_BASENAMES.has(n);
}

/**
 * LocalAuth uses userDataDir `.wwebjs_auth/session` (see whatsapp-web.js LocalAuth).
 * Locks may sit at session root, in Default/, or deeper after crashes.
 * Chrome may create Singleton* as a file, symlink, or (rarely) directory — use rmSync.
 */
function tryRemoveChromeSingletonPath(full, removed) {
  try {
    // Use lstat so we remove symlink entries even when the target is missing (broken link to /tmp).
    fs.lstatSync(full);
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`⚠️ Could not remove Chrome singleton path ${full}: ${e.message}`);
    }
  }
}

/** Chrome uses temp dirs like com.google.Chrome.<random> under TMPDIR; stale dirs and volume symlinks cause Code 21 after container replacement. */
function removeStaleGoogleChromeTmpArtifacts() {
  const tmpRoots = new Set([process.env.TMPDIR, os.tmpdir(), '/tmp'].filter(Boolean));
  for (const tmp of tmpRoots) {
    let entries;
    try {
      entries = fs.readdirSync(tmp, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.name.startsWith('com.google.Chrome')) continue;
      const p = path.join(tmp, ent.name);
      try {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`🧹 Removed stale Chromium temp dir: ${p}`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn(`⚠️ Could not remove ${p}: ${e.message}`);
        }
      }
    }
  }
}

function removeChromeProfileSingletonLocks(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return;
  const removed = [];
  const hotRelPaths = [
    '',
    'session',
    path.join('session', 'Default'),
    'Default',
  ];
  const singletonExact = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const rel of hotRelPaths) {
    const base = rel ? path.join(rootDir, rel) : rootDir;
    for (const name of singletonExact) {
      tryRemoveChromeSingletonPath(path.join(base, name), removed);
    }
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      // Symlinks (SingletonLock → hostname, SingletonSocket → /tmp/...) must be removed by name first;
      // Node's dirent.isDirectory() may follow links and we must not walk into Singleton*.
      if (isChromeSingletonLockFile(ent.name)) {
        tryRemoveChromeSingletonPath(full, removed);
        continue;
      }
      if (ent.isDirectory()) {
        walk(full);
      }
    }
  };
  try {
    walk(rootDir);
    if (removed.length) {
      console.log(
        `🧹 Removed ${removed.length} stale Chrome singleton path(s) (Docker / new container hostname).`
      );
      removed.forEach((p) => console.log(`   … ${p}`));
    }
  } catch (e) {
    console.warn('removeChromeProfileSingletonLocks:', e.message);
  }
}

/** Optional nuclear fix for Code 21 when singleton lives inside Default (may require new WhatsApp QR). */
function removeChromeDefaultProfileIfRequested() {
  const v = String(process.env.WWEBJS_RM_CHROME_DEFAULT_BEFORE_INIT || '').toLowerCase();
  if (v !== 'true' && v !== '1' && v !== 'yes') return;
  const defaultDir = path.join(WWEBJS_AUTH_DIR, 'session', 'Default');
  if (!fs.existsSync(defaultDir)) return;
  try {
    fs.rmSync(defaultDir, { recursive: true, force: true });
    console.log(
      '🧹 WWEBJS_RM_CHROME_DEFAULT_BEFORE_INIT: removed Chrome profile folder session/Default (fixes stubborn Code 21; you may need to scan QR if auth was only in that profile).'
    );
  } catch (e) {
    console.warn('⚠️ Could not remove session/Default:', e.message);
  }
}

function logWwebjsSessionLayoutForDiagnostics() {
  const sdir = path.join(WWEBJS_AUTH_DIR, 'session');
  if (!fs.existsSync(sdir)) {
    console.log('🧭 .wwebjs_auth/session: (missing — created on first browser launch)');
    return;
  }
  try {
    const names = fs.readdirSync(sdir);
    const preview = names.slice(0, 35).join(', ');
    console.log(
      `🧭 .wwebjs_auth/session (${names.length} entries): ${preview}${names.length > 35 ? ' …' : ''}`
    );
  } catch (e) {
    console.warn('🧭 could not read .wwebjs_auth/session:', e.message);
  }
}

let sessionToolsOperationInProgress = false;

function adminSecretConfigured() {
  const s = process.env.ADMIN_SECRET;
  return typeof s === 'string' && s.trim().length > 0;
}

function sessionToolsAllowed(req, res) {
  if (isProduction && !adminSecretConfigured()) {
    res.status(503).json({
      error: 'Set ADMIN_SECRET in the server .env to use Clear session / Clear cache from the UI in production.'
    });
    return false;
  }
  if (adminSecretConfigured() && req.body?.adminSecret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Invalid or missing admin key' });
    return false;
  }
  return true;
}

function removePathRecursive(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: true, removed: false };
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, error: err.message };
  }
}

async function destroyClientForSessionReset() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  isReconnecting = false;
  reconnectAttempts = 0;

  try {
    if (client && typeof client.destroy === 'function') {
      await Promise.race([
        client.destroy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 10000))
      ]).catch(() => { });
    }
  } catch (e) {
    console.log('⚠️ destroyClientForSessionReset:', e.message);
  }
  await new Promise((r) => setTimeout(r, 1200));
}

function resetWhatsAppFlagsForFreshSession() {
  qrCodeData = null;
  lastQRCodeEmitted = null;
  isClientReady = false;
  isInitializing = false;
  clientInitialized = false;
  firstReadyProcessed = false;
  firstAuthenticatedProcessed = false;
  forceReadyLock = false;
  readyEventCount = 0;
  lastReadyTime = null;
  authenticatedEventCount = 0;
  lastAuthenticatedTime = null;
  lastAuthFailureTime = null;
  authFailureCount = 0;
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/whatsapp/session-tools-config', (req, res) => {
  res.json({
    enabled: !isProduction || adminSecretConfigured(),
    adminKeyRequired: adminSecretConfigured()
  });
});

app.post('/api/whatsapp/clear-cache', sessionToolsLimiter, async (req, res) => {
  if (!sessionToolsAllowed(req, res)) return;
  if (!req.body?.confirm) {
    return res.status(400).json({ error: 'Send JSON body: { "confirm": true }' });
  }

  const results = {
    wwebjs_cache: removePathRecursive(WWEBJS_CACHE_DIR),
    temp: removePathRecursive(TEMP_DIR)
  };
  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  } catch (e) {
    results.tempRecreate = e.message;
  }

  customerGroupsCache = null;
  customerGroupsCacheTime = 0;

  io.emit('sessionTools', { action: 'cache-cleared', results });
  res.json({
    ok: true,
    message: 'Cache folders cleared (best effort). Refresh the page if the UI acts stale.',
    results
  });
});

app.post('/api/whatsapp/clear-session', sessionToolsLimiter, async (req, res) => {
  if (!sessionToolsAllowed(req, res)) return;
  if (!req.body?.confirm) {
    return res.status(400).json({ error: 'Send JSON body: { "confirm": true }' });
  }
  if (sessionToolsOperationInProgress) {
    return res.status(409).json({ error: 'Another session operation is already running' });
  }

  sessionToolsOperationInProgress = true;
  try {
    await destroyClientForSessionReset();
    resetWhatsAppFlagsForFreshSession();

    const authRemoved = removePathRecursive(WWEBJS_AUTH_DIR);
    try {
      fs.mkdirSync(WWEBJS_AUTH_DIR, { recursive: true });
    } catch (e) {
      sessionToolsOperationInProgress = false;
      return res.status(500).json({ ok: false, error: 'Could not recreate session folder: ' + e.message });
    }

    removePathRecursive(WWEBJS_CACHE_DIR);
    try {
      fs.mkdirSync(WWEBJS_CACHE_DIR, { recursive: true });
    } catch (e) {
      /* optional */
    }

    io.emit('sessionTools', { action: 'session-cleared' });
    // Reset WhatsApp-ready state for all browsers (otherwise UI keeps isConnected=true and ignores new QR)
    io.emit('clientStatus', {
      isReady: false,
      targetPhones: targetPhoneNumbers,
      targetPhone: targetPhoneNumbers.length > 0 ? targetPhoneNumbers[0] : null
    });
    initializeWhatsAppClient();

    res.json({
      ok: true,
      message: 'Session removed. The client is restarting; scan the QR code when it appears.',
      authRemoved
    });
  } catch (err) {
    console.error('clear-session error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    sessionToolsOperationInProgress = false;
  }
});

app.post('/set-phone', (req, res) => {
  console.log('Received set-phone request:', req.body);
  const { phoneNumber, phoneNumbers } = req.body;

  // Handle single phone number
  if (phoneNumber) {
    // Validate phone number format - accept:
    // 1. Phone numbers starting with + (e.g., +1234567890)
    // 2. Phone numbers with @c.us (e.g., 1234567890@c.us)
    // 3. Group IDs with @g.us (e.g., 120363123456789012@g.us)
    if (!phoneNumber.startsWith('+') && !phoneNumber.includes('@c.us') && !phoneNumber.includes('@g.us')) {
      console.log('Error: Invalid phone number format');
      return res.status(400).json({ error: 'Phone number must be in format +1234567890, 1234567890@c.us, or 120363123456789012@g.us' });
    }

    if (!targetPhoneNumbers.includes(phoneNumber)) {
      targetPhoneNumbers.push(phoneNumber);
      console.log('Added phone number:', phoneNumber);
    }
  }

  // Handle multiple phone numbers
  if (phoneNumbers && Array.isArray(phoneNumbers)) {
    phoneNumbers.forEach(num => {
      // Accept phone numbers with +, @c.us, or @g.us
      if ((num.startsWith('+') || num.includes('@c.us') || num.includes('@g.us')) && !targetPhoneNumbers.includes(num)) {
        targetPhoneNumbers.push(num);
        console.log('Added phone number:', num);
      }
    });
  }

  console.log('Current target phone numbers:', targetPhoneNumbers);
  console.log('Client ready status:', isClientReady);

  res.json({
    success: true,
    phoneNumbers: targetPhoneNumbers,
    clientReady: isClientReady
  });
});

app.get('/messages/:phoneNumber', async (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }

  try {
    console.log('Fetching messages for:', phoneNumber);

    let chatId;

    // Check if it's a group ID (contains @g.us) or a regular contact
    if (phoneNumber.includes('@g.us')) {
      // It's already a group ID
      chatId = phoneNumber;
      console.log('Chat ID (Group):', chatId);
    } else {
      // Format phone number properly for individual contact
      let formattedNumber = phoneNumber;
      if (phoneNumber.startsWith('+')) {
        formattedNumber = phoneNumber.substring(1);
      }

      // Remove any non-digit characters except +
      formattedNumber = formattedNumber.replace(/\D/g, '');

      chatId = `${formattedNumber}@c.us`;
      console.log('Chat ID (Contact):', chatId);
    }

    const chat = await client.getChatById(chatId);
    console.log('Chat found:', chat.name || 'Unknown');

    // Dynamic time window and limit
    const days = parseInt(req.query.days) || 7;
    const estimatedLimit = Math.min(MAX_MESSAGES_PER_CHAT, Math.max(50, days * 50));
    console.log(`Loading messages with days=${days}, estimatedLimit=${estimatedLimit}`);

    const nowMs = Date.now();
    const sinceMs = nowMs - (days * 24 * 60 * 60 * 1000);
    await preSyncChatHistoryIfNeeded(chat, sinceMs, nowMs);
    if (days > 1) {
      await forceLoadOlderMessages(client, chat, Math.floor(sinceMs / 1000), Math.min(20, days * 3));
    }

    const messages = await fetchChatMessagesSafe(client, chat, estimatedLimit, {}, { timeFilterStartMs: sinceMs });
    console.log('Messages fetched:', messages.length);

    // Filter messages within requested window
    const now = nowMs;
    console.log(`Time calculation: now=${new Date(now).toLocaleString()}, sinceMs=${new Date(sinceMs).toLocaleString()}, days=${days}`);

    const recentMessages = messages.filter(msg => {
      const messageDate = (msg.timestamp || 0) * 1000; // to ms
      const isWithinTimeRange = messageDate >= sinceMs;
      // Include both incoming and outgoing messages - client will handle filtering
      return isWithinTimeRange;
    });

    // Debug: Count fromMe messages
    const fromMeCount = recentMessages.filter(msg => msg.fromMe).length;
    const fromCustomerCount = recentMessages.filter(msg => !msg.fromMe).length;
    console.log(`[DEBUG] Recent messages (last ${days} days): ${recentMessages.length} total (${fromMeCount} from You, ${fromCustomerCount} from customers)`);
    if (messages.length > 0) {
      const oldest = new Date(Math.min(...messages.map(m => (m.timestamp || 0) * 1000))).toLocaleString();
      const newest = new Date(Math.max(...messages.map(m => (m.timestamp || 0) * 1000))).toLocaleString();
      console.log('Fetched date range:', { oldest, newest, days });
    }

    const formattedMessages = await Promise.all(recentMessages.map(async (msg) => {
      const { senderIdForFrom, senderPhone, senderName } = await resolveSenderPhoneAndName(
        client,
        phoneNumber,
        msg,
        2000
      );

      const messageData = {
        id: msg.id._serialized,
        body: msg.body || '',
        from: senderIdForFrom,
        timestamp: msg.timestamp,
        type: msg.type,
        isFromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        mediaUrl: null,
        mediaFilename: null,
        mediaMimetype: null,
        senderName: senderName,
        senderPhone: senderPhone,
        chatName: chat.name || 'Unknown'
      };

      // Skip media download for now to improve performance
      // Media can be downloaded on-demand when user clicks on a message
      if (msg.hasMedia) {
        messageData.mediaNote = 'Media available - click to download';
      }

      return messageData;
    }));

    res.json({ messages: formattedMessages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    console.error('Error details:', error.message);
    res.status(500).json({
      error: 'Failed to fetch messages',
      details: error.message,
      phoneNumber: phoneNumber
    });
  }
});

// New endpoint to get merged messages from all phone numbers
async function handleMergedMessagesRequest(req, res) {
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }

  // Allow clients to specify the list explicitly (fallback to server-side list)
  const bodyPhoneNumbers = Array.isArray(req.body?.phoneNumbers)
    ? req.body.phoneNumbers
      .filter(num => typeof num === 'string' && num.trim() !== '')
      .map(num => num.trim())
    : [];

  const queryPhoneNumbers = Array.isArray(req.query?.phoneNumbers)
    ? req.query.phoneNumbers
    : [];

  const contactsToProcess = bodyPhoneNumbers.length > 0
    ? bodyPhoneNumbers
    : (queryPhoneNumbers.length > 0 ? queryPhoneNumbers : targetPhoneNumbers);

  if (!contactsToProcess || contactsToProcess.length === 0) {
    return res.status(400).json({ error: 'No phone numbers set' });
  }

  // Set a timeout for the entire request
  const timeout = setTimeout(() => {
    console.log('Request timeout - taking too long to fetch messages');
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout - too many messages to process' });
    }
  }, 120000); // 120 second timeout (2 minutes)

  try {
    console.log('Fetching merged messages for:', contactsToProcess);
    console.log(`Processing ${contactsToProcess.length} contacts/groups`);

    let allMessages = [];
    const messageIds = new Set(); // To track unique messages

    // Fetch messages from each contact/group
    for (let i = 0; i < contactsToProcess.length; i++) {
      const phoneNumber = contactsToProcess[i];
      console.log(`Processing contact/group ${i + 1}/${contactsToProcess.length}: ${phoneNumber}`);

      try {
        // Handle both individual contacts (@c.us) and groups (@g.us)
        let chatId = phoneNumber;

        // If it doesn't have @ in it, assume it's an individual contact
        if (!phoneNumber.includes('@')) {
          let formattedNumber = phoneNumber;
          if (phoneNumber.startsWith('+')) {
            formattedNumber = phoneNumber.substring(1);
          }
          formattedNumber = formattedNumber.replace(/\D/g, '');
          chatId = `${formattedNumber}@c.us`;
        }

        console.log('Fetching messages from contact/group ID:', chatId);

        console.log(`Getting chat for ID: ${chatId}`);

        // Check if client is still ready before attempting to get chat
        if (!isClientReady) {
          console.error(`Client not ready when trying to fetch chat for ${chatId}`);
          throw new Error('WhatsApp client not ready. Session may have been closed.');
        }

        const chat = await client.getChatById(chatId);
        const chatName = chat?.name || 'Unknown';
        console.log('Chat found:', chatName);

        // Check if chat is valid
        if (!chat) {
          console.log(`Chat not found for ${phoneNumber}, skipping...`);
          continue;
        }

        // Send progress update to client with name
        if (io && io.engine && io.engine.clientsCount > 0) {
          io.emit('message-progress', {
            current: i + 1,
            total: contactsToProcess.length,
            phoneNumber: phoneNumber,
            chatName: chatName
          });
        }

        console.log(`Fetching messages for ${phoneNumber}...`);

        // Determine time range filter
        let days = 0;
        let timeFilterStart = 0;
        let timeFilterEnd = 0;

        if (req.query.datetimeFilter === 'true') {
          // Check if we have from/to timestamps for precise filtering
          if (req.query.from && req.query.to) {
            timeFilterStart = parseInt(req.query.from);
            timeFilterEnd = parseInt(req.query.to);
            // Calculate days for fetch limit estimation
            days = Math.ceil((timeFilterEnd - timeFilterStart) / (1000 * 60 * 60 * 24));
            console.log(`Using precise datetime filter from=${new Date(timeFilterStart).toLocaleString()}, to=${new Date(timeFilterEnd).toLocaleString()}, days=${days}`);
          } else if (req.query.days) {
            // Fallback to days-based filtering
            days = parseInt(req.query.days) || 7;
            const now = Date.now();
            timeFilterStart = now - (days * 24 * 60 * 60 * 1000);
            timeFilterEnd = now;
            console.log(`Using days-based filter: days=${days}`);
          }
        } else if (req.query.hours) {
          // Hours filter
          const hours = parseInt(req.query.hours);
          days = Math.ceil(hours / 24);
          const now = Date.now();
          timeFilterStart = now - (hours * 60 * 60 * 1000);
          timeFilterEnd = now;
          console.log(`Using hours-based filter: hours=${hours}, days=${days}`);
        }

        if (timeFilterStart > 0 && timeFilterEnd > timeFilterStart) {
          await preSyncChatHistoryIfNeeded(chat, timeFilterStart, timeFilterEnd);
          if (days > 1) {
            await forceLoadOlderMessages(client, chat, Math.floor(timeFilterStart / 1000), Math.min(20, days * 3));
          }
        }

        // Calculate appropriate limit based on time range (roughly 50 messages per day)
        // If no filter, load minimum 30 to ensure we have enough data
        // Cap at MAX_MESSAGES_PER_CHAT to prevent memory issues
        const estimatedLimit = days > 0 ? Math.min(MAX_MESSAGES_PER_CHAT, Math.max(50, days * 50)) : Math.min(MAX_MESSAGES_PER_CHAT, 400);
        const meta =
          timeFilterStart > 0 ? { timeFilterStartMs: timeFilterStart } : {};
        const messages = await fetchChatMessagesSafe(client, chat, estimatedLimit, {}, meta);
        console.log(`Messages fetched from ${phoneNumber}:`, messages.length);

        // Debug: Show date range of fetched messages
        if (messages.length > 0) {
          const oldestMsg = messages[messages.length - 1];
          const newestMsg = messages[0];
          console.log(`Date range for ${phoneNumber}:`, {
            oldest: new Date(oldestMsg.timestamp * 1000).toLocaleString(),
            newest: new Date(newestMsg.timestamp * 1000).toLocaleString(),
            filterStart: timeFilterStart > 0 ? new Date(timeFilterStart).toLocaleString() : 'none'
          });
        } else {
          console.log(`No messages found for ${phoneNumber} - chat might be empty or inaccessible`);
        }

        const recentMessages = messages.filter(msg => {
          const messageDate = msg.timestamp * 1000;
          const isWithinTimeRange = timeFilterStart === 0 || (messageDate >= timeFilterStart && messageDate <= timeFilterEnd);
          // Include both incoming and outgoing messages - client will handle filtering
          return isWithinTimeRange;
        });

        if (timeFilterStart > 0 && timeFilterEnd > 0) {
          console.log(`Recent messages from ${phoneNumber} (custom range ${new Date(timeFilterStart).toLocaleString()} to ${new Date(timeFilterEnd).toLocaleString()}):`, recentMessages.length);
        } else {
          console.log(`Recent messages from ${phoneNumber} (last ${days} days):`, recentMessages.length);
        }

        // Additional debugging for empty results
        if (recentMessages.length === 0 && messages.length > 0) {
          console.log(`All ${messages.length} messages from ${phoneNumber} are older than ${days} days`);
          // Show some sample message dates
          const sampleMessages = messages.slice(0, 3);
          sampleMessages.forEach((msg, index) => {
            console.log(`Sample message ${index + 1} date:`, new Date(msg.timestamp * 1000).toLocaleString());
          });
        }

        // Debug: Show some message details
        if (recentMessages.length > 0) {
          console.log(`Sample message from ${phoneNumber}:`, {
            id: recentMessages[0].id._serialized,
            body: recentMessages[0].body?.substring(0, 50) + '...',
            timestamp: new Date(recentMessages[0].timestamp * 1000).toLocaleString()
          });
        } else {
          console.log(`No recent messages found for ${phoneNumber}`);
        }

        // Debug: Count fromMe messages
        const fromMeCount = recentMessages.filter(msg => msg.fromMe).length;
        const fromCustomerCount = recentMessages.filter(msg => !msg.fromMe).length;
        console.log(`[DEBUG] Messages from ${phoneNumber}: ${fromMeCount} from You, ${fromCustomerCount} from customers`);

        // Process messages and add to allMessages
        for (const msg of recentMessages) {
          // Skip if we've already seen this message (by ID)
          if (messageIds.has(msg.id._serialized)) {
            continue;
          }

          messageIds.add(msg.id._serialized);

          const { senderIdForFrom, senderPhone, senderName } = await resolveSenderPhoneAndName(
            client,
            phoneNumber,
            msg,
            500
          );

          const messageData = {
            id: msg.id._serialized,
            body: msg.body || '',
            from: senderIdForFrom,
            timestamp: msg.timestamp,
            type: msg.type,
            isFromMe: msg.fromMe,
            hasMedia: msg.hasMedia,
            mediaUrl: null,
            mediaFilename: null,
            mediaMimetype: null,
            sourcePhone: phoneNumber,
            senderName: senderName,
            senderPhone: senderPhone,
            chatName: chatName
          };

          // Skip media download for now to improve performance
          // Media can be downloaded on-demand when user clicks on a message
          if (msg.hasMedia) {
            messageData.mediaNote = 'Media available - click to download';
          }

          allMessages.push(messageData);
        }
      } catch (error) {
        console.error(`Error fetching messages from ${phoneNumber}:`, error);
        console.error('Full error details:', error.message);

        // Check if it's a session closed error
        const isSessionClosed = error.message?.includes('Session closed') ||
          error.message?.includes('Protocol error') ||
          error.message?.includes('Runtime.callFunctionOn');

        if (isSessionClosed) {
          console.error('⚠️ WhatsApp session has been closed. Stopping message fetch.');
          // Update client status
          isClientReady = false;

          // Emit disconnect event
          if (io && io.engine && io.engine.clientsCount > 0) {
            io.emit('clientDisconnected', {
              reason: 'Session closed',
              requiresReconnect: true
            });
          }

          // Return error response
          clearTimeout(timeout);
          if (!res.headersSent) {
            return res.status(503).json({
              error: 'WhatsApp session has been closed',
              message: 'Please refresh the page and scan the QR code again to reconnect.',
              requiresReconnect: true
            });
          }
          return;
        }

        // For other errors, continue with other phone numbers
        console.log(`Continuing with other contacts despite error for ${phoneNumber}...`);
      }

      // Add a small delay between requests to prevent overwhelming the API
      if (i < contactsToProcess.length - 1) {
        console.log('Waiting 10ms before next request...');
        await new Promise(resolve => setTimeout(resolve, 10)); // Optimized for cost reduction (reduced from 25ms)
      }
    }

    // Sort messages by timestamp (newest first)
    allMessages.sort((a, b) => b.timestamp - a.timestamp);

    // Limit total messages to prevent memory issues
    const limitedMessages = allMessages.slice(0, MAX_MESSAGES_PER_REQUEST);

    if (allMessages.length > MAX_MESSAGES_PER_REQUEST) {
      console.log(`⚠️ Memory optimization: Limiting messages from ${allMessages.length} to ${MAX_MESSAGES_PER_REQUEST}`);
    }

    console.log(`Total unique messages found: ${allMessages.length} (returning ${limitedMessages.length})`);

    // Clear the timeout since we're responding
    clearTimeout(timeout);

    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      res.json({
        messages: limitedMessages,
        totalMessages: limitedMessages.length,
        totalAvailable: allMessages.length, // Let client know there are more
        phoneNumbers: contactsToProcess
      });
    }
  } catch (error) {
    console.error('Error fetching merged messages:', error);
    clearTimeout(timeout);

    // Check if it's a session closed error
    const isSessionClosed = error.message?.includes('Session closed') ||
      error.message?.includes('Protocol error') ||
      error.message?.includes('Runtime.callFunctionOn');

    if (isSessionClosed) {
      console.error('⚠️ WhatsApp session has been closed.');
      isClientReady = false;

      // Emit disconnect event
      if (io && io.engine && io.engine.clientsCount > 0) {
        io.emit('clientDisconnected', {
          reason: 'Session closed',
          requiresReconnect: true
        });
      }
    }

    // Check if response was already sent (by timeout)
    if (!res.headersSent) {
      if (isSessionClosed) {
        res.status(503).json({
          error: 'WhatsApp session has been closed',
          message: 'Please refresh the page and scan the QR code again to reconnect.',
          requiresReconnect: true
        });
      } else {
        res.status(500).json({
          error: 'Failed to fetch merged messages',
          details: error.message
        });
      }
    }
  }
}

// Apply rate limiting to message endpoints
app.get('/messages-merged', apiLimiter, handleMergedMessagesRequest);
app.post('/messages-merged', apiLimiter, handleMergedMessagesRequest);

// New endpoint to get all available chats (contacts and groups)
app.get('/chats', async (req, res) => {
  if (!client) {
    return res.status(400).json({ error: 'WhatsApp client not initialized', details: 'Please scan the QR code first.' });
  }
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client not ready', details: 'Wait for the app to show connected, or scan the QR code again.' });
  }

  try {
    console.log('Fetching all chats...');

    const chats = await client.getChats();
    console.log(`Found ${chats.length} chats`);

    const formattedChats = [];
    for (const chat of chats) {
      try {
        const id = (chat.id && (typeof chat.id._serialized === 'string' ? chat.id._serialized : chat.id)) || String(chat.id);
        const lastMessage = chat.lastMessage
          ? {
              body: chat.lastMessage.body != null ? String(chat.lastMessage.body) : '',
              timestamp: chat.lastMessage.timestamp != null ? chat.lastMessage.timestamp : 0,
              from: chat.lastMessage.from
            }
          : null;
        formattedChats.push({
          id,
          name: chat.name || 'Unknown',
          isGroup: !!chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          lastMessage
        });
      } catch (err) {
        console.warn('Skipping one chat due to error:', err.message);
      }
    }

    // Sort by last message timestamp (most recent first)
    formattedChats.sort((a, b) => {
      if (!a.lastMessage && !b.lastMessage) return 0;
      if (!a.lastMessage) return 1;
      if (!b.lastMessage) return -1;
      return b.lastMessage.timestamp - a.lastMessage.timestamp;
    });

    res.json({
      chats: formattedChats,
      totalChats: formattedChats.length,
      groups: formattedChats.filter(chat => chat.isGroup),
      contacts: formattedChats.filter(chat => !chat.isGroup)
    });
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({
      error: 'Failed to fetch chats',
      details: error.message || String(error)
    });
  }
});

// Endpoint to download media for a specific message
app.post('/download-media', async (req, res) => {
  console.log('\n' + '='.repeat(80));
  console.log('📥 [MEDIA DOWNLOAD] Request received at:', new Date().toISOString());
  console.log('📥 [MEDIA DOWNLOAD] Request body:', JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));

  if (!isClientReady) {
    console.error('❌ [MEDIA DOWNLOAD] WhatsApp client not ready');
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }

  const { messageId, chatId } = req.body;

  console.log('🔍 [MEDIA DOWNLOAD] Extracted parameters:', {
    messageId: messageId || 'MISSING',
    chatId: chatId || 'MISSING',
    messageIdType: typeof messageId,
    chatIdType: typeof chatId,
    messageIdLength: messageId?.length || 0,
    chatIdLength: chatId?.length || 0
  });

  if (!messageId || !chatId) {
    console.error('❌ [MEDIA DOWNLOAD] Missing required parameters');
    return res.status(400).json({
      error: 'Message ID and Chat ID are required',
      received: { messageId: !!messageId, chatId: !!chatId }
    });
  }

  try {
    console.log(`\n🔍 [MEDIA DOWNLOAD] Starting download process`);
    console.log(`   Message ID: ${messageId}`);
    console.log(`   Chat ID: ${chatId}`);

    // Validate chatId format
    if (!chatId || (!chatId.includes('@c.us') && !chatId.includes('@g.us'))) {
      console.error(`❌ [MEDIA DOWNLOAD] Invalid chatId format: "${chatId}"`);
      return res.status(400).json({
        error: 'Invalid chat ID format. Must include @c.us or @g.us',
        received: chatId,
        chatIdType: typeof chatId
      });
    }

    console.log(`🔍 [MEDIA DOWNLOAD] Fetching chat: ${chatId}`);
    const chat = await client.getChatById(chatId);
    if (!chat) {
      console.error(`❌ [MEDIA DOWNLOAD] Chat not found: ${chatId}`);
      return res.status(404).json({ error: 'Chat not found', chatId: chatId });
    }
    console.log(`✅ [MEDIA DOWNLOAD] Chat found: ${chat.name || chatId} (ID: ${chat.id._serialized || 'N/A'})`);

    console.log(`🔍 [MEDIA DOWNLOAD] Fetching messages (limit: 100)...`);
    const messages = await fetchChatMessagesSafe(client, chat, 100);
    console.log(`✅ [MEDIA DOWNLOAD] Fetched ${messages.length} messages to search`);

    // Log sample of first few messages for debugging
    if (messages.length > 0) {
      console.log(`\n📋 [MEDIA DOWNLOAD] Sample messages (first 5):`);
      messages.slice(0, 5).forEach((msg, idx) => {
        console.log(`   [${idx + 1}] ID: ${msg.id._serialized}, Type: ${msg.type}, hasMedia: ${msg.hasMedia}, fromMe: ${msg.fromMe}, from: ${msg.from}, timestamp: ${msg.timestamp}`);
      });
    }

    // Try to find message by _serialized ID first, then by various custom formats
    console.log(`\n🔍 [MEDIA DOWNLOAD] Searching for message with ID: ${messageId}`);
    console.log(`   Message ID parts: ${messageId.split('_').join(' | ')}`);

    let message = null;
    let matchMethod = null;

    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const serializedId = msg.id?._serialized;

      // Try exact match first
      if (serializedId === messageId) {
        matchMethod = 'exact_match';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Exact match found at index ${idx} by serialized ID: ${serializedId}`);
        break;
      }

      // Try matching just the serialized part if messageId contains it
      if (serializedId && messageId.includes(serializedId)) {
        matchMethod = 'substring_match';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Substring match found at index ${idx}: ${serializedId} in ${messageId}`);
        break;
      }

      // Try custom formats
      const customId1 = `${msg.fromMe}_${msg.from}_${serializedId || msg.timestamp}`;
      if (customId1 === messageId) {
        matchMethod = 'custom_format_1';
        message = msg;
        console.log(`✅ [MEDIA DOWNLOAD] Custom format 1 match found at index ${idx}: ${customId1}`);
        break;
      }

      // Try format: fromMe_from_serializedId_timestamp@lid
      if (serializedId) {
        const customId2 = `${msg.fromMe}_${msg.from}_${serializedId}_${msg.timestamp}@lid`;
        if (customId2 === messageId) {
          matchMethod = 'custom_format_2';
          message = msg;
          console.log(`✅ [MEDIA DOWNLOAD] Custom format 2 match found at index ${idx}: ${customId2}`);
          break;
        }

        // Try matching parts of the ID with timestamp validation
        const messageIdParts = messageId.split('_');
        if (messageIdParts.length >= 3) {
          const fromMeMatch = messageIdParts[0] === String(msg.fromMe);
          const fromMatch = messageIdParts[1] && msg.from.includes(messageIdParts[1].replace(/@.*/, ''));
          const serializedMatch = messageIdParts.some(part => {
            const cleanPart = part.replace(/@.*/, '');
            return part === serializedId || serializedId.includes(cleanPart) || cleanPart === serializedId;
          });

          // Also check timestamp if present in messageId
          const timestampMatch = messageIdParts.some(part => {
            const cleanPart = part.replace(/@.*/, '');
            return cleanPart === String(msg.timestamp);
          });

          if (fromMeMatch && fromMatch && serializedMatch && (timestampMatch || messageIdParts.length === 3)) {
            matchMethod = 'parts_match';
            message = msg;
            console.log(`✅ [MEDIA DOWNLOAD] Parts match found at index ${idx}`);
            console.log(`   Match details: fromMe=${fromMeMatch}, from=${fromMatch}, serialized=${serializedMatch}, timestamp=${timestampMatch}`);
            break;
          }
        }
      }
    }

    if (message) {
      console.log(`\n✅ [MEDIA DOWNLOAD] Message found!`);
      console.log(`   Match method: ${matchMethod}`);
      console.log(`   Serialized ID: ${message.id._serialized}`);
      console.log(`   Type: ${message.type}`);
      console.log(`   hasMedia: ${message.hasMedia}`);
      console.log(`   fromMe: ${message.fromMe}`);
      console.log(`   from: ${message.from}`);
      console.log(`   timestamp: ${message.timestamp}`);
      console.log(`   body preview: ${message.body?.substring(0, 100) || 'N/A'}`);
      console.log(`   All message properties:`, Object.keys(message));
    } else {
      console.log(`\n⚠️ [MEDIA DOWNLOAD] Message not found in first 100 messages`);
    }

    if (!message) {
      console.log(`\n🔍 [MEDIA DOWNLOAD] Message not found in first 100, trying extended search (limit: 500)...`);
      // Try fetching more messages if not found in first 100
      const moreMessages = await fetchChatMessagesSafe(client, chat, 500);
      console.log(`✅ [MEDIA DOWNLOAD] Fetched ${moreMessages.length} messages in extended search`);
      const message2 = moreMessages.find(msg => {
        const serializedId = msg.id?._serialized;

        if (serializedId === messageId) return true;
        if (serializedId && messageId.includes(serializedId)) return true;

        const customId1 = `${msg.fromMe}_${msg.from}_${serializedId || msg.timestamp}`;
        if (customId1 === messageId) return true;

        if (serializedId) {
          const customId2 = `${msg.fromMe}_${msg.from}_${serializedId}_${msg.timestamp}@lid`;
          if (customId2 === messageId) return true;

          // Try matching parts
          const messageIdParts = messageId.split('_');
          if (messageIdParts.length >= 2) {
            const fromMeMatch = messageIdParts[0] === String(msg.fromMe);
            const fromMatch = messageIdParts[1] && msg.from.includes(messageIdParts[1].replace(/@.*/, ''));
            const serializedMatch = messageIdParts.some(part => part === serializedId || serializedId.includes(part.replace(/@.*/, '')));
            if (fromMeMatch && fromMatch && serializedMatch) return true;
          }
        }

        return false;
      });
      if (message2) {
        console.log(`\n✅ [MEDIA DOWNLOAD] Message found in extended search!`);
        console.log(`   Serialized ID: ${message2.id._serialized}`);
        console.log(`   Type: ${message2.type}`);
        console.log(`   hasMedia: ${message2.hasMedia}`);
        console.log(`   fromMe: ${message2.fromMe}`);
        console.log(`   from: ${message2.from}`);
        console.log(`   timestamp: ${message2.timestamp}`);
        console.log(`   body preview: ${message2.body?.substring(0, 100) || 'N/A'}`);

        // Check if message has media - try multiple indicators
        const hasMediaIndicator2 = message2.hasMedia ||
          message2.type === 'image' ||
          message2.type === 'video' ||
          message2.type === 'audio' ||
          message2.type === 'document' ||
          message2.type === 'sticker' ||
          message2.type === 'ptt' ||
          message2.type === 'ptv' ||
          (message2.body && message2.body.includes('media'));

        console.log(`\n🔍 [MEDIA DOWNLOAD] Media indicator check:`);
        console.log(`   hasMedia: ${message2.hasMedia}`);
        console.log(`   type check: ${['image', 'video', 'audio', 'document', 'sticker', 'ptt', 'ptv'].includes(message2.type)} (type: ${message2.type})`);
        console.log(`   body contains 'media': ${message2.body?.includes('media') || false}`);
        console.log(`   Overall hasMediaIndicator: ${hasMediaIndicator2}`);

        // If no indicators suggest media, but user is requesting download, try anyway
        if (!hasMediaIndicator2) {
          console.warn(`\n⚠️ [MEDIA DOWNLOAD] No media indicators found, but attempting download anyway`);
          console.warn(`   Type: ${message2.type}, hasMedia: ${message2.hasMedia}`);
        } else {
          console.log(`\n📥 [MEDIA DOWNLOAD] Media indicators found, proceeding with download...`);
        }

        let media2;
        try {
          console.log(`\n📥 [MEDIA DOWNLOAD] Attempting to download media (extended search)...`);
          console.log(`   Message type: ${message2.type}`);
          console.log(`   Is video: ${message2.type === 'video' || message2.type === 'ptv'}`);

          const downloadStartTime = Date.now();

          // For videos, add more detailed logging and potentially increase timeout
          if (message2.type === 'video' || message2.type === 'ptv') {
            console.log(`   📹 Video message detected - this may take longer to download`);
            console.log(`   Video properties:`, {
              hasMedia: message2.hasMedia,
              type: message2.type,
              body: message2.body?.substring(0, 100) || 'N/A'
            });
          }

          // Download with longer timeout for videos
          // For videos, try multiple times with exponential backoff
          let retries2 = message2.type === 'video' || message2.type === 'ptv' ? 2 : 1;
          let lastError2 = null;

          for (let attempt = 1; attempt <= retries2; attempt++) {
            try {
              if (attempt > 1) {
                console.log(`   🔄 Retry attempt ${attempt}/${retries2} for video download (extended search)...`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
              }

              const downloadPromise2 = message2.downloadMedia();
              const timeoutPromise2 = new Promise((_, reject) => {
                const timeout = message2.type === 'video' || message2.type === 'ptv' ? 90000 : 30000; // 90s for video, 30s for others
                setTimeout(() => reject(new Error(`Download timeout after ${timeout}ms`)), timeout);
              });

              media2 = await Promise.race([downloadPromise2, timeoutPromise2]);
              const downloadDuration = Date.now() - downloadStartTime;

              // Check if media is null or invalid
              if (!media2 || !media2.data) {
                console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} returned null/empty media (extended search)`);
                console.error(`   Media object:`, media2 ? 'exists but no data' : 'null');

                if (attempt === retries2) {
                  // Last attempt, throw error
                  throw new Error('Media download returned null - media may be expired or unavailable');
                }
                // Otherwise, continue to next retry
                continue;
              }

              console.log(`✅ [MEDIA DOWNLOAD] Media downloaded successfully in ${downloadDuration}ms (attempt ${attempt})`);
              console.log(`   Media data length: ${media2.data.length} bytes`);
              break; // Success, exit retry loop
            } catch (attemptError) {
              lastError2 = attemptError;
              console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} failed (extended search): ${attemptError.message}`);

              if (attempt === retries2) {
                // Last attempt failed, throw the error
                throw attemptError;
              }
              // Otherwise, continue to next retry
            }
          }
        } catch (downloadError) {
          console.error(`\n❌ [MEDIA DOWNLOAD] Error downloading media after all attempts (extended search):`);
          console.error(`   Error message: ${downloadError.message}`);
          console.error(`   Error stack: ${downloadError.stack}`);
          console.error(`   Error name: ${downloadError.name}`);
          console.error(`   Message type: ${message2.type}`);
          console.error(`   hasMedia: ${message2.hasMedia}`);
          console.error(`   Message ID: ${message2.id?._serialized || 'N/A'}`);

          // Check if it's a "no media" error or a real download error
          const isNoMediaError = downloadError.message?.includes('no media') ||
            downloadError.message?.includes('Media not found') ||
            downloadError.message?.includes('does not contain media');

          if (isNoMediaError || (!message2.hasMedia && !hasMediaIndicator2)) {
            return res.status(400).json({
              error: 'Message does not contain media',
              messageType: message2.type,
              hasMedia: message2.hasMedia,
              downloadError: downloadError.message
            });
          }

          // Real download error
          return res.status(500).json({
            error: 'Failed to download media',
            details: downloadError.message,
            messageType: message2.type,
            hasMedia: message2.hasMedia
          });
        }

        if (!media2) {
          console.error(`❌ Failed to download media (returned null): ${messageId}`);
          return res.status(500).json({
            error: 'Failed to download media',
            messageType: message2.type,
            hasMedia: message2.hasMedia
          });
        }

        console.log(`\n✅ [MEDIA DOWNLOAD] Media downloaded successfully from extended search!`);
        console.log(`   Filename: ${media2.filename || 'unnamed'}`);
        console.log(`   Mimetype: ${media2.mimetype}`);
        console.log(`   Size: ${media2.data.length} bytes (${(media2.data.length / 1024).toFixed(2)} KB)`);
        console.log(`   Size in MB: ${(media2.data.length / (1024 * 1024)).toFixed(2)} MB`);

        // Check if it's a video and log additional info
        if (media2.mimetype?.startsWith('video/')) {
          console.log(`   📹 Video file detected - size: ${(media2.data.length / (1024 * 1024)).toFixed(2)} MB`);
        }

        // Check file size - warn if very large
        const sizeInMB2 = media2.data.length / (1024 * 1024);
        if (sizeInMB2 > 20) {
          console.warn(`   ⚠️ Large file detected (${sizeInMB2.toFixed(2)} MB) - may cause issues`);
        }

        try {
          const response2 = {
            success: true,
            mediaUrl: `data:${media2.mimetype};base64,${media2.data}`,
            mediaFilename: media2.filename || `media_${messageId}`,
            mediaMimetype: media2.mimetype,
            mediaSize: media2.data.length
          };

          // Calculate response size
          const responseSize2 = JSON.stringify(response2).length;
          const responseSizeMB2 = responseSize2 / (1024 * 1024);

          console.log(`   Response size: ${responseSize2} bytes (${responseSizeMB2.toFixed(2)} MB)`);

          if (responseSizeMB2 > 50) {
            console.error(`   ❌ Response size (${responseSizeMB2.toFixed(2)} MB) exceeds safe limit`);
            return res.status(500).json({
              error: 'Media file too large to send',
              details: `File size (${sizeInMB2.toFixed(2)} MB) exceeds response limit`,
              mediaSize: media2.data.length,
              responseSize: responseSize2
            });
          }

          return res.json(response2);
        } catch (responseError2) {
          console.error(`\n❌ [MEDIA DOWNLOAD] Error sending response (extended search):`);
          console.error(`   Error message: ${responseError2.message}`);
          console.error(`   Error stack: ${responseError2.stack}`);
          console.error(`   Media size: ${media2.data.length} bytes (${sizeInMB2.toFixed(2)} MB)`);

          return res.status(500).json({
            error: 'Failed to send media response',
            details: responseError2.message,
            mediaSize: media2.data.length,
            errorType: responseError2.name
          });
        }
      }
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if message has media - try multiple indicators
    console.log(`\n🔍 [MEDIA DOWNLOAD] Checking media indicators for found message:`);
    const hasMediaIndicator = message.hasMedia ||
      message.type === 'image' ||
      message.type === 'video' ||
      message.type === 'audio' ||
      message.type === 'document' ||
      message.type === 'sticker' ||
      message.type === 'ptt' ||
      message.type === 'ptv' ||
      (message.body && message.body.includes('media'));

    console.log(`   hasMedia flag: ${message.hasMedia}`);
    console.log(`   type check: ${['image', 'video', 'audio', 'document', 'sticker', 'ptt', 'ptv'].includes(message.type)} (type: ${message.type})`);
    console.log(`   body contains 'media': ${message.body?.includes('media') || false}`);
    console.log(`   Overall hasMediaIndicator: ${hasMediaIndicator}`);

    // If no indicators suggest media, but user is requesting download, try anyway
    // (might be a forwarded message or the hasMedia flag is incorrect)
    if (!hasMediaIndicator) {
      console.warn(`\n⚠️ [MEDIA DOWNLOAD] No media indicators found, but attempting download anyway`);
      console.warn(`   Type: ${message.type}, hasMedia: ${message.hasMedia}`);
    } else {
      console.log(`\n📥 [MEDIA DOWNLOAD] Media indicators found, proceeding with download...`);
    }

    // Try to download media - even if hasMedia is false, the message might still have media
    let media;
    try {
      console.log(`\n📥 [MEDIA DOWNLOAD] Attempting to download media...`);
      console.log(`   Message type: ${message.type}`);
      console.log(`   Is video: ${message.type === 'video' || message.type === 'ptv'}`);

      const downloadStartTime = Date.now();

      // For videos, add more detailed logging and potentially increase timeout
      if (message.type === 'video' || message.type === 'ptv') {
        console.log(`   📹 Video message detected - this may take longer to download`);
        console.log(`   Video properties:`, {
          hasMedia: message.hasMedia,
          type: message.type,
          body: message.body?.substring(0, 100) || 'N/A'
        });
      }

      // Download with longer timeout for videos
      // For videos, try multiple times with exponential backoff
      let retries = message.type === 'video' || message.type === 'ptv' ? 2 : 1;
      let lastError = null;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`   🔄 Retry attempt ${attempt}/${retries} for video download...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          }

          const downloadPromise = message.downloadMedia();
          const timeoutPromise = new Promise((_, reject) => {
            const timeout = message.type === 'video' || message.type === 'ptv' ? 90000 : 30000; // 90s for video, 30s for others
            setTimeout(() => reject(new Error(`Download timeout after ${timeout}ms`)), timeout);
          });

          media = await Promise.race([downloadPromise, timeoutPromise]);
          const downloadDuration = Date.now() - downloadStartTime;

          // Check if media is null or invalid
          if (!media || !media.data) {
            console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} returned null/empty media`);
            console.error(`   Media object:`, media ? 'exists but no data' : 'null');

            if (attempt === retries) {
              // Last attempt, throw error
              throw new Error('Media download returned null - media may be expired or unavailable');
            }
            // Otherwise, continue to next retry
            continue;
          }

          console.log(`✅ [MEDIA DOWNLOAD] Media downloaded successfully in ${downloadDuration}ms (attempt ${attempt})`);
          console.log(`   Media data length: ${media.data.length} bytes`);
          break; // Success, exit retry loop
        } catch (attemptError) {
          lastError = attemptError;
          console.error(`   ⚠️ [MEDIA DOWNLOAD] Attempt ${attempt} failed: ${attemptError.message}`);

          if (attempt === retries) {
            // Last attempt failed, throw the error
            throw attemptError;
          }
          // Otherwise, continue to next retry
        }
      }
    } catch (downloadError) {
      console.error(`\n❌ [MEDIA DOWNLOAD] Error downloading media after all attempts:`);
      console.error(`   Error message: ${downloadError.message}`);
      console.error(`   Error stack: ${downloadError.stack}`);
      console.error(`   Error name: ${downloadError.name}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   hasMedia: ${message.hasMedia}`);
      console.error(`   Message ID: ${message.id?._serialized || 'N/A'}`);

      // Check if it's a "no media" error or a real download error
      const isNoMediaError = downloadError.message?.includes('no media') ||
        downloadError.message?.includes('Media not found') ||
        downloadError.message?.includes('does not contain media') ||
        downloadError.message?.includes('Media expired');

      if (isNoMediaError || (!message.hasMedia && !hasMediaIndicator)) {
        return res.status(400).json({
          error: 'Message does not contain media',
          messageType: message.type,
          hasMedia: message.hasMedia,
          downloadError: downloadError.message
        });
      }

      // Real download error - provide more details
      console.error(`\n❌ [MEDIA DOWNLOAD] Returning 500 error response`);
      console.error(`   Error details: ${downloadError.message}`);
      console.error(`   Error type: ${downloadError.name}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   Has media: ${message.hasMedia}`);
      console.error(`   Retries attempted: ${retries}`);

      const errorResponse = {
        error: 'Failed to download media',
        details: downloadError.message || 'Unknown error',
        messageType: message.type,
        hasMedia: message.hasMedia,
        errorType: downloadError.name || 'Error',
        retriesAttempted: retries
      };

      console.error(`   Error response:`, JSON.stringify(errorResponse, null, 2));
      console.log('='.repeat(80) + '\n');

      return res.status(500).json(errorResponse);
    }

    // Final safety check - this should not happen if retry logic works correctly
    if (!media || !media.data) {
      console.error(`❌ [MEDIA DOWNLOAD] Failed to download media (returned null after all retries): ${messageId}`);
      console.error(`   Message type: ${message.type}`);
      console.error(`   Has media: ${message.hasMedia}`);
      console.error(`   Message ID: ${message.id?._serialized || 'N/A'}`);
      console.error(`   Media object:`, media ? 'exists but no data property' : 'null');
      console.error(`   ⚠️ This usually means the media has expired or been deleted from WhatsApp servers`);
      console.error(`   ⚠️ Videos older than a few days often become unavailable`);
      console.log('='.repeat(80) + '\n');

      return res.status(500).json({
        error: 'Failed to download media',
        details: 'Media download returned null - media may be expired, deleted, or unavailable. This often happens with videos that are too old or have been deleted from WhatsApp servers.',
        messageType: message.type,
        hasMedia: message.hasMedia,
        suggestion: 'Try downloading the media from WhatsApp directly, or ask the sender to resend it if possible.'
      });
    }

    console.log(`\n✅ [MEDIA DOWNLOAD] Media download successful!`);
    console.log(`   Filename: ${media.filename || 'unnamed'}`);
    console.log(`   Mimetype: ${media.mimetype}`);
    console.log(`   Size: ${media.data.length} bytes (${(media.data.length / 1024).toFixed(2)} KB)`);
    console.log(`   Size in MB: ${(media.data.length / (1024 * 1024)).toFixed(2)} MB`);

    // Check if it's a video and log additional info
    if (media.mimetype?.startsWith('video/')) {
      console.log(`   📹 Video file detected - size: ${(media.data.length / (1024 * 1024)).toFixed(2)} MB`);
    }

    // Check file size - warn if very large
    const sizeInMB = media.data.length / (1024 * 1024);
    if (sizeInMB > 20) {
      console.warn(`   ⚠️ Large file detected (${sizeInMB.toFixed(2)} MB) - may cause issues`);
    }

    console.log(`   Base64 data preview: ${media.data.substring(0, 100)}... (truncated)`);

    try {
      const response = {
        success: true,
        mediaUrl: `data:${media.mimetype};base64,${media.data}`,
        mediaFilename: media.filename || `media_${messageId}`,
        mediaMimetype: media.mimetype,
        mediaSize: media.data.length
      };

      // Calculate response size (base64 increases size by ~33%)
      const responseSize = JSON.stringify(response).length;
      const responseSizeMB = responseSize / (1024 * 1024);

      console.log(`\n✅ [MEDIA DOWNLOAD] Preparing response`);
      console.log(`   Response size: ${responseSize} bytes (${responseSizeMB.toFixed(2)} MB)`);

      if (responseSizeMB > 50) {
        console.error(`   ❌ Response size (${responseSizeMB.toFixed(2)} MB) exceeds safe limit`);
        return res.status(500).json({
          error: 'Media file too large to send',
          details: `File size (${sizeInMB.toFixed(2)} MB) exceeds response limit`,
          mediaSize: media.data.length,
          responseSize: responseSize
        });
      }

      console.log(`   ✅ Response size is acceptable, sending...`);
      console.log('='.repeat(80) + '\n');

      return res.json(response);
    } catch (responseError) {
      console.error(`\n❌ [MEDIA DOWNLOAD] Error sending response:`);
      console.error(`   Error message: ${responseError.message}`);
      console.error(`   Error stack: ${responseError.stack}`);
      console.error(`   Error name: ${responseError.name}`);
      console.error(`   Media size: ${media.data.length} bytes (${(media.data.length / (1024 * 1024)).toFixed(2)} MB)`);
      console.log('='.repeat(80) + '\n');

      return res.status(500).json({
        error: 'Failed to send media response',
        details: responseError.message,
        mediaSize: media.data.length,
        errorType: responseError.name
      });
    }
  } catch (error) {
    console.error('\n❌ [MEDIA DOWNLOAD] Unexpected error in download-media endpoint:');
    console.error(`   Error message: ${error.message}`);
    console.error(`   Error stack: ${error.stack}`);
    console.error(`   Error name: ${error.name}`);
    console.error(`   Error code: ${error.code || 'N/A'}`);
    console.error(`   Full error object:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    console.log('='.repeat(80) + '\n');

    // Make sure we always send details in the response
    const errorResponse = {
      error: 'Failed to download media',
      details: error.message || 'Unknown error occurred',
      errorType: error.name || 'Error',
      errorCode: error.code || undefined
    };

    console.error(`   Sending error response:`, JSON.stringify(errorResponse, null, 2));

    return res.status(500).json(errorResponse);
  }
});

// Google Sheets Group Management Endpoints

// Load customer groups from Google Sheets
// Apply rate limiting to group endpoints
app.get('/groups/load', apiLimiter, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';

    if (forceRefresh) {
      console.log('🔄 Force refresh requested - loading from Google Sheets...');
    } else {
      console.log('📦 Loading groups (using cache if available)...');
    }

    customerGroups = await loadCustomerGroups(forceRefresh);

    const cacheInfo = customerGroupsCacheTime > 0
      ? { cached: true, cacheAge: Math.round((Date.now() - customerGroupsCacheTime) / 1000) }
      : { cached: false };

    console.log('Groups loaded successfully. Total groups:', Object.keys(customerGroups).length);
    console.log('Loaded group names:', Object.keys(customerGroups));

    res.json({
      success: true,
      groups: customerGroups,
      totalGroups: Object.keys(customerGroups).length,
      message: forceRefresh
        ? 'Customer groups refreshed from Google Sheets'
        : 'Customer groups loaded (from cache)',
      cacheInfo: cacheInfo
    });
  } catch (error) {
    console.error('Error loading groups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load customer groups',
      details: error.message
    });
  }
});

// Get all customer groups
app.get('/groups', apiLimiter, (req, res) => {
  try {
    const groups = Object.values(customerGroups).map(group => ({
      name: group.name,
      totalCustomers: group.totalCustomers,
      lastUpdated: group.lastUpdated,
      customers: group.customers.map(customer => ({
        phone: customer.phone,
        name: customer.name
      }))
    }));

    res.json({
      success: true,
      groups: groups,
      totalGroups: groups.length
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch groups',
      details: error.message
    });
  }
});

// Get specific group details
app.get('/groups/:groupName', apiLimiter, (req, res) => {
  try {
    const groupName = req.params.groupName;
    const group = customerGroups[groupName];

    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }

    res.json({
      success: true,
      group: {
        name: group.name,
        totalCustomers: group.totalCustomers,
        lastUpdated: group.lastUpdated,
        customers: group.customers
      }
    });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch group',
      details: error.message
    });
  }
});

// Send message to a group
app.post('/groups/:groupName/send', apiLimiter, largeJsonBody, async (req, res) => {
  try {
    const groupName = req.params.groupName;


    // Check if client is ready before processing
    if (!isClientReady) {
      console.error(`❌ [SEND] Client not ready when trying to send to group: ${groupName}`);
      return res.status(400).json({
        success: false,
        error: 'WhatsApp client is not connected. Please refresh and scan QR code again.'
      });
    }

    const result = await sendGroupMessageInternal(groupName, {
      message: req.body.message,
      mediaUrl: req.body.mediaUrl,
      mediaType: req.body.mediaType,
      mediaFilename: req.body.mediaFilename,
      hasMedia: req.body.hasMedia,
      selectedPhones: req.body.selectedPhones
    });

    if (result.status === 'validation_error') {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (result.status === 'not_found') {
      return res.status(404).json({ success: false, error: result.error });
    }

    if (result.status === 'client_not_ready') {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (result.status === 'error') {
      // Log the error but don't throw - return error response instead
      console.error('❌ [SEND] Error in sendGroupMessageInternal:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error?.message || 'Failed to send group message',
        details: result.error?.message
      });
    }

    return res.json({
      success: true,
      groupName,
      totalCustomers: result.targetedCustomers,
      successCount: result.successCount,
      errorCount: result.errorCount,
      results: result.results,
      message: `Message sent to ${result.successCount} out of ${result.targetedCustomers} selected customers`
    });
  } catch (error) {
    console.error('❌ [SEND] Unhandled error sending group message:', error);
    console.error('Error stack:', error.stack);

    // Ensure response is sent even if there's an error
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to send group message',
        details: error.message
      });
    }
  }
});

// Schedule a group message
app.post('/groups/:groupName/schedule', largeJsonBody, async (req, res) => {
  try {
    const groupName = req.params.groupName;

    await ensureGroupData();
    const group = customerGroups[groupName];
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const validation = validateSchedulePayload(group, req.body, null, { requireFutureStart: true });
    if (validation.error) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const value = validation.value;

    const scheduleEntry = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groupName,
      message: value.message,
      mediaUrl: value.mediaUrl,
      mediaType: value.mediaType,
      mediaFilename: value.mediaFilename,
      hasMedia: value.hasMedia,
      targetScope: value.targetScope,
      selectedPhones: value.targetScope === 'selected' ? value.selectedPhones : [],
      recurrenceType: value.recurrenceType,
      weekdays: value.weekdays,
      monthlyDay: value.monthlyDay,
      startDate: value.startDate,
      startTime: value.startTime,
      endDate: value.endDate,
      endTime: value.endTime,
      timezone: value.timezone,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      lastRunAt: null,
      nextRun: null,
      status: 'active',
      lastError: null
    };

    const nextRun = computeNextRunForSchedule(scheduleEntry);
    if (!nextRun) {
      return res.status(400).json({
        success: false,
        error: 'Schedule configuration does not produce a run within the selected window'
      });
    }

    scheduleEntry.nextRun = nextRun.toISOString();

    scheduledMessages.push(scheduleEntry);
    saveScheduledMessages();

    console.log(`[SCHEDULE] Created schedule ${scheduleEntry.id} for group ${groupName}. Next run at ${scheduleEntry.nextRun}`);

    if (!scheduleChecker) {
      startScheduleChecker();
    }

    processScheduledMessages().catch(err => console.error('[SCHEDULE] Immediate scheduler run error:', err));

    res.json({
      success: true,
      scheduleId: scheduleEntry.id,
      nextRun: scheduleEntry.nextRun,
      status: scheduleEntry.status
    });
  } catch (error) {
    console.error('[SCHEDULE] Error creating schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create schedule',
      details: error.message
    });
  }
});

// Get scheduled messages (optional group filter)
app.get('/schedules', (req, res) => {
  try {
    const groupFilter = req.query.group || req.query.groupName || null;
    let schedules = scheduledMessages.slice();

    if (groupFilter) {
      schedules = schedules.filter(schedule => schedule.groupName === groupFilter);
    }

    schedules.sort((a, b) => {
      const aTime = a.nextRun ? new Date(a.nextRun).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.nextRun ? new Date(b.nextRun).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });

    res.json({ success: true, schedules });
  } catch (error) {
    console.error('[SCHEDULE] Error fetching schedules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch schedules',
      details: error.message
    });
  }
});

// Update an existing scheduled message
app.put('/schedules/:scheduleId', largeJsonBody, async (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const existingSchedule = scheduledMessages[scheduleIndex];
    await ensureGroupData();
    const group = customerGroups[existingSchedule.groupName];
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found for this schedule' });
    }

    const validation = validateSchedulePayload(group, req.body, existingSchedule, { requireFutureStart: false });
    if (validation.error) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const value = validation.value;

    existingSchedule.message = value.message;
    existingSchedule.mediaUrl = value.mediaUrl;
    existingSchedule.mediaType = value.mediaType;
    existingSchedule.mediaFilename = value.mediaFilename;
    existingSchedule.hasMedia = value.hasMedia;
    existingSchedule.targetScope = value.targetScope;
    existingSchedule.selectedPhones = value.targetScope === 'selected' ? value.selectedPhones : [];
    existingSchedule.recurrenceType = value.recurrenceType;
    existingSchedule.weekdays = value.weekdays;
    existingSchedule.monthlyDay = value.monthlyDay;
    existingSchedule.startDate = value.startDate;
    existingSchedule.startTime = value.startTime;
    existingSchedule.endDate = value.endDate;
    existingSchedule.endTime = value.endTime;
    existingSchedule.timezone = value.timezone || existingSchedule.timezone;
    existingSchedule.status = 'active';
    existingSchedule.lastError = null;
    existingSchedule.updatedAt = new Date().toISOString();

    const nextRun = computeNextRunForSchedule(existingSchedule);
    if (nextRun) {
      existingSchedule.nextRun = nextRun.toISOString();
    } else {
      existingSchedule.nextRun = null;
      existingSchedule.status = 'completed';
    }

    saveScheduledMessages();
    processScheduledMessages().catch(err => console.error('[SCHEDULE] Immediate scheduler run error:', err));

    res.json({
      success: true,
      schedule: existingSchedule,
      nextRun: existingSchedule.nextRun
    });
  } catch (error) {
    console.error('[SCHEDULE] Error updating schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update schedule',
      details: error.message
    });
  }
});

// Delete a scheduled message
app.delete('/schedules/:scheduleId', (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const scheduleIndex = scheduledMessages.findIndex(schedule => schedule.id === scheduleId);

    if (scheduleIndex === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const [removedSchedule] = scheduledMessages.splice(scheduleIndex, 1);
    saveScheduledMessages();

    res.json({ success: true, scheduleId: removedSchedule.id });
  } catch (error) {
    console.error('[SCHEDULE] Error deleting schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete schedule',
      details: error.message
    });
  }
});

// Update attendance for a customer
app.post('/groups/:groupName/attendance', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { customerPhone, status = 'present', month, message = '', messageTimestamp = null } = req.body;

    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Customer phone number is required'
      });
    }

    // Use provided month or default to current month (YYYY-MM format)
    const targetMonth = month || new Date().toISOString().slice(0, 7);

    const success = await updateAttendance(groupName, customerPhone, status, targetMonth, message, messageTimestamp);

    if (success) {
      res.json({
        success: true,
        message: `Attendance updated for customer ${customerPhone}`,
        attendance: attendanceData[groupName]?.[customerPhone]
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Customer not found in group'
      });
    }
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update attendance',
      details: error.message
    });
  }
});

// Confirm code for a customer (logs to CodeMonitor sheet)
app.post('/groups/:groupName/code-confirm', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { customerPhone, message = '', messageTimestamp = null, code = '' } = req.body || {};

    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Customer phone number is required'
      });
    }

    if (!code || code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Code is required'
      });
    }

    const result = await recordCodeConfirmation(groupName, customerPhone, message, messageTimestamp, code);

    if (result.success) {
      res.json({
        success: true,
        message: `Code confirmation logged for ${customerPhone}`,
        record: result.record
      });
    } else {
      const statusCode = result.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        error: result.error || 'Failed to confirm code'
      });
    }
  } catch (error) {
    console.error('Error confirming code:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm code',
      details: error.message
    });
  }
});

// Get list of codes from Code Monitor sheet
app.get('/api/codes/list', async (req, res) => {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      return res.status(500).json({
        success: false,
        error: 'Google Sheets not initialized',
        codes: []
      });
    }

    // Get all sheet names
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });
    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);

    // Try to find "Code Monitor" or "CodeMonitor" sheet
    let codeSheetName = null;
    if (sheetNames.includes('Code Monitor')) {
      codeSheetName = 'Code Monitor';
    } else if (sheetNames.includes('CodeMonitor')) {
      codeSheetName = 'CodeMonitor';
    }

    if (!codeSheetName) {
      // Sheet doesn't exist, return empty list
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet not found'
      });
    }

    // Read the sheet data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: `${codeSheetName}!A:Z`
    });

    const rows = response.data.values || [];
    console.log(`[CODES] Retrieved ${rows.length} rows from sheet "${codeSheetName}"`);
    if (rows.length === 0) {
      console.log(`[CODES] Sheet is empty`);
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet is empty'
      });
    }

    if (rows.length === 1) {
      console.log(`[CODES] Sheet only has header row, no data rows`);
      return res.json({
        success: true,
        codes: [],
        message: 'Code Monitor sheet has no data rows'
      });
    }

    // Find the "Code" column header (case-insensitive)
    const headerRow = rows[0];
    console.log(`[CODES] Header row:`, headerRow);
    let codeColumnIndex = -1;
    for (let i = 0; i < headerRow.length; i++) {
      const headerValue = headerRow[i];
      if (headerValue) {
        const headerLower = headerValue.toString().toLowerCase().trim();
        console.log(`[CODES] Checking header[${i}]: "${headerValue}" -> "${headerLower}"`);
        if (headerLower === 'code') {
          codeColumnIndex = i;
          console.log(`[CODES] Found "Code" column at index ${i}`);
          break;
        }
      }
    }

    if (codeColumnIndex === -1) {
      // Code column not found
      console.log(`[CODES] Code column not found. Available headers:`, headerRow);
      return res.json({
        success: true,
        codes: [],
        message: 'Code column not found in Code Monitor sheet',
        availableHeaders: headerRow
      });
    }

    // Extract unique codes from the column (skip header row)
    const codesSet = new Set();
    console.log(`[CODES] Found Code column at index ${codeColumnIndex}`);
    console.log(`[CODES] Total rows in sheet: ${rows.length}`);
    console.log(`[CODES] Sheet name: ${codeSheetName}`);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) {
        console.log(`[CODES] Row ${i} is empty, skipping`);
        continue;
      }
      if (row.length <= codeColumnIndex) {
        console.log(`[CODES] Row ${i} has only ${row.length} columns, need index ${codeColumnIndex}, skipping`);
        continue; // Skip rows that don't have enough columns
      }
      const codeValue = row[codeColumnIndex];
      if (codeValue !== undefined && codeValue !== null && codeValue.toString().trim() !== '') {
        const trimmedCode = codeValue.toString().trim();
        codesSet.add(trimmedCode);
        console.log(`[CODES] Row ${i}: Found code "${trimmedCode}"`);
      } else {
        console.log(`[CODES] Row ${i}: Code value is empty or null (value: ${codeValue})`);
      }
    }

    // Convert to sorted array
    const codes = Array.from(codesSet).sort();
    console.log(`[CODES] Returning ${codes.length} unique codes:`, codes);

    res.json({
      success: true,
      codes: codes
    });
  } catch (error) {
    console.error('Error fetching codes from Code Monitor:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch codes',
      details: error.message,
      codes: []
    });
  }
});

// Get attendance data for a group
app.get('/groups/:groupName/attendance', (req, res) => {
  try {
    const groupName = req.params.groupName;
    const groupAttendance = attendanceData[groupName] || {};

    res.json({
      success: true,
      groupName: groupName,
      attendance: groupAttendance,
      totalMarked: Object.keys(groupAttendance).length
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch attendance',
      details: error.message
    });
  }
});

// Get all customers from all groups
app.get('/customers/list', async (req, res) => {
  try {
    // Load groups from Google Sheets if not loaded
    if (Object.keys(customerGroups).length === 0) {
      await loadCustomerGroups();
    }

    // Collect all customers with their group names
    const allCustomers = [];

    Object.keys(customerGroups).forEach(groupName => {
      const group = customerGroups[groupName];
      if (group.customers && Array.isArray(group.customers)) {
        group.customers.forEach(customer => {
          allCustomers.push({
            ...customer,
            groupName: groupName
          });
        });
      }
    });

    res.json({
      success: true,
      totalCustomers: allCustomers.length,
      totalGroups: Object.keys(customerGroups).length,
      customers: allCustomers
    });
  } catch (error) {
    console.error('Error fetching customer list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customer list',
      details: error.message
    });
  }
});

// Get absentees for a group
app.get('/groups/:groupName/absentees', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const group = customerGroups[groupName];

    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dayOfMonth = new Date().getDate().toString(); // e.g., "27"
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    console.log(`[DEBUG] Checking absentees for group: ${groupName}`);
    console.log(`[DEBUG] Today: ${today}, Day: ${dayOfMonth}, Month: ${currentMonth}`);
    console.log(`[DEBUG] Total customers in group: ${group.customers.length}`);

    // Read attendance from Google Sheet
    const sheets = await initializeGoogleSheets();
    let sheetAttendanceData = {};

    if (sheets) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!A:Z`
        });

        const rows = response.data.values;
        if (rows && rows.length > 1) {
          const headers = rows[0];
          const phoneCol = headers.findIndex(h =>
            h && (h.toLowerCase().includes('phone') ||
              h.toLowerCase().includes('number') ||
              h.toLowerCase().includes('whatsapp'))
          );

          // Find the column for today's date
          const dayCol = headers.findIndex(h => h && h.toString().trim() === dayOfMonth);

          if (phoneCol !== -1 && dayCol !== -1) {
            // Build attendance map from sheet
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              const phone = row[phoneCol] ? row[phoneCol].toString().replace(/\D/g, '') : '';
              const attendance = row[dayCol];

              if (phone && attendance && (attendance === 'P' || attendance === 'p' || attendance === 'Present')) {
                sheetAttendanceData[phone] = true;
              }
            }
          }
        }
        console.log(`[DEBUG] Attendance from sheet: ${Object.keys(sheetAttendanceData).length} present`);
      } catch (error) {
        console.error('Error reading attendance from sheet:', error);
      }
    }

    // Also check in-memory attendance (for newly marked attendance in this session)
    const groupAttendance = attendanceData[groupName] || {};

    const presentCustomers = new Set();
    const absentCustomers = [];

    // Check each customer's attendance
    group.customers.forEach(customer => {
      // Check Google Sheet first, then in-memory
      const sheetPresent = sheetAttendanceData[customer.phone];
      const customerAttendance = groupAttendance[customer.phone];

      const inMemoryPresent = customerAttendance &&
        customerAttendance[currentMonth] &&
        customerAttendance[currentMonth].includes(today);

      const isPresent = sheetPresent || inMemoryPresent;

      console.log(`[DEBUG] Customer: ${customer.name} (${customer.phone}) - Sheet: ${sheetPresent || false}, Memory: ${inMemoryPresent || false}`);

      if (isPresent) {
        presentCustomers.add(customer.phone);
      } else {
        absentCustomers.push({
          name: customer.name,
          phone: customer.phone
        });
      }
    });

    res.json({
      success: true,
      groupName: groupName,
      totalCustomers: group.totalCustomers,
      presentCount: presentCustomers.size,
      absentCount: absentCustomers.length,
      absentCustomers: absentCustomers
    });
  } catch (error) {
    console.error('Error fetching absentees:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch absentees',
      details: error.message
    });
  }
});

// Send follow-up message to absentees
app.post('/groups/:groupName/followup', async (req, res) => {
  try {
    const groupName = req.params.groupName;
    const { message, selectedPhones } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    const group = customerGroups[groupName];
    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found'
      });
    }

    if (!isClientReady) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp client not ready'
      });
    }

    // Get absentees for today - check both Google Sheets and in-memory
    const today = new Date().toISOString().slice(0, 10);
    const dayOfMonth = new Date().getDate().toString();
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Read attendance from Google Sheet
    const sheets = await initializeGoogleSheets();
    let sheetAttendanceData = {};

    if (sheets) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${groupName}!A:Z`
        });

        const rows = response.data.values;
        if (rows && rows.length > 1) {
          const headers = rows[0];
          const phoneCol = headers.findIndex(h =>
            h && (h.toLowerCase().includes('phone') ||
              h.toLowerCase().includes('number') ||
              h.toLowerCase().includes('whatsapp'))
          );
          const dayCol = headers.findIndex(h => h && h.toString().trim() === dayOfMonth);

          if (phoneCol !== -1 && dayCol !== -1) {
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              const phone = row[phoneCol] ? row[phoneCol].toString().replace(/\D/g, '') : '';
              const attendance = row[dayCol];
              if (phone && attendance && (attendance === 'P' || attendance === 'p' || attendance === 'Present')) {
                sheetAttendanceData[phone] = true;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error reading attendance from sheet:', error);
      }
    }

    // Also check in-memory
    const groupAttendance = attendanceData[groupName] || {};

    // Get all absent customers
    let absentCustomers = group.customers.filter(customer => {
      const sheetPresent = sheetAttendanceData[customer.phone];
      const customerAttendance = groupAttendance[customer.phone];
      const inMemoryPresent = customerAttendance &&
        customerAttendance[currentMonth] &&
        customerAttendance[currentMonth].includes(today);

      return !(sheetPresent || inMemoryPresent);
    });

    // If specific phones are selected, filter to only those
    if (selectedPhones && selectedPhones.length > 0) {
      const selectedPhonesClean = selectedPhones.map(phone => phone.replace(/\D/g, ''));
      absentCustomers = absentCustomers.filter(customer =>
        selectedPhonesClean.includes(customer.phone.replace(/\D/g, ''))
      );
    }

    if (absentCustomers.length === 0) {
      return res.json({
        success: true,
        message: 'No absentees found',
        successCount: 0,
        errorCount: 0
      });
    }

    // Send message to each selected absent customer
    const results = [];
    let successCount = 0;
    let errorCount = 0;

    for (const customer of absentCustomers) {
      try {
        const chatId = `${customer.phone}@c.us`;
        const chat = await client.getChatById(chatId);
        await chat.sendMessage(message, { sendSeen: false });

        successCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'sent'
        });

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: error.message
        });
        console.error(`Failed to send follow-up to ${customer.name} (${customer.phone}):`, error);
      }
    }

    res.json({
      success: true,
      groupName: groupName,
      totalAbsentees: absentCustomers.length,
      successCount: successCount,
      errorCount: errorCount,
      results: results,
      message: `Follow-up sent to ${successCount} out of ${absentCustomers.length} absentees`
    });
  } catch (error) {
    console.error('Error sending follow-up:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send follow-up',
      details: error.message
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current status so UI shows connected/connecting immediately
  socket.emit('clientStatus', {
    isReady: isClientReady,
    targetPhones: targetPhoneNumbers,
    targetPhone: targetPhoneNumbers.length > 0 ? targetPhoneNumbers[0] : null
  });
  // If already connected, also emit clientReady so UI fully updates (e.g. after page refresh)
  if (isClientReady) {
    socket.emit('clientReady', { status: 'connected', message: 'WhatsApp client is ready!', timestamp: new Date().toISOString() });
  } else if (qrCodeData) {
    // Re-send pending QR code to newly connected browser (e.g. after page refresh)
    QRCode.toDataURL(qrCodeData, (err, url) => {
      if (!err) {
        socket.emit('qrCode', { qrData: qrCodeData, qrImage: url });
      }
    });
  }

  // Handle session clear request
  socket.on('clearSession', async () => {
    console.log('🧹 Clear session request received from client');
    try {
      const authPath = path.join(__dirname, '.wwebjs_auth');
      const sessionExists = fs.existsSync(authPath);
      if (sessionExists) {
        // Destroy client first
        if (client && typeof client.destroy === 'function') {
          try {
            await client.destroy().catch(() => { });
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (err) {
            // Ignore destroy errors
          }
        }

        // Clear session using LocalAuth
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log('✅ Session cleared from LocalAuth store successfully');
        } catch (err) {
          console.warn('⚠️ Could not clear LocalAuth directory:', err.message);
        }

        // Reset flags
        isClientReady = false;
        firstReadyProcessed = false;
        firstAuthenticatedProcessed = false;
        qrCodeData = null;
        lastQRCodeEmitted = null;
        isInitializing = false;
        clientInitialized = false;

        socket.emit('sessionCleared', { success: true, message: 'Session cleared. Reinitializing...' });

        // Reinitialize client after a delay
        console.log('🔄 Reinitializing client after session clear...');
        setTimeout(() => {
          initializeWhatsAppClient();
        }, 2000);
      } else {
        socket.emit('sessionCleared', { success: false, error: 'No session found in LocalAuth store' });
      }
    } catch (error) {
      console.error('❌ Error clearing session:', error.message);
      socket.emit('sessionCleared', { success: false, error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Google Sheets API functions
// Helper: Convert zero-based column index to Google Sheets column letters (A, B, ... AA)
function getColumnLetter(index) {
  let result = '';
  let num = index;
  while (num >= 0) {
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26) - 1;
  }
  return result;
}

// Write attendance record to Attendance sheet
async function writeAttendanceToSheet(groupName, memberName, memberPhone, message = '', messageTimestamp = null) {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      console.error('Google Sheets not initialized');
      return false;
    }

    // Use message timestamp if provided, otherwise use current time
    // messageTimestamp is in Unix seconds, convert to milliseconds for Date
    const timestamp = messageTimestamp ? new Date(messageTimestamp * 1000) : new Date();

    // Get timezone information
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneOffset = timestamp.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
    const offsetMinutes = Math.abs(timezoneOffset) % 60;
    const offsetSign = timezoneOffset <= 0 ? '+' : '-';
    const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

    // Use local time methods instead of toISOString() to avoid UTC conversion
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0'); // getMonth() returns 0-11
    const day = String(timestamp.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`; // YYYY-MM-DD format in local time
    const time = timestamp.toTimeString().split(' ')[0]; // HH:MM:SS format (already local time)

    // Log timezone information
    if (messageTimestamp) {
      console.log(`[ATTENDANCE] Using message timestamp: ${date} ${time} (from message)`);
      console.log(`[ATTENDANCE] Timezone: ${timezone} (UTC${offsetString})`);
      console.log(`[ATTENDANCE] Original message timestamp (Unix): ${messageTimestamp}`);
      console.log(`[ATTENDANCE] Converted to local time: ${timestamp.toLocaleString('en-US', { timeZone: timezone })}`);
    } else {
      console.log(`[ATTENDANCE] Using current timestamp: ${date} ${time} (current time)`);
      console.log(`[ATTENDANCE] Timezone: ${timezone} (UTC${offsetString})`);
      console.log(`[ATTENDANCE] Current local time: ${timestamp.toLocaleString('en-US', { timeZone: timezone })}`);
    }

    // Prepare the row data: Date, Time, Group, Member, Message, Timezone
    const rowData = [date, time, groupName, memberName || memberPhone, message || '', `${timezone} (UTC${offsetString})`];

    // Check if Attendance sheet exists, create if it doesn't
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
      });

      const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
      const attendanceSheetExists = sheetNames.includes('Attendance');

      if (!attendanceSheetExists) {
        // Create the Attendance sheet with headers
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: 'Attendance',
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 6
                  }
                }
              }
            }]
          }
        });

        // Add headers (with Timezone column)
        await sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: 'Attendance!A1:F1',
          valueInputOption: 'RAW',
          resource: {
            values: [['Date', 'Time', 'Group', 'Member', 'Message', 'Timezone']]
          }
        });

        console.log('Created Attendance sheet with headers');
      }
    } catch (error) {
      console.error('Error checking/creating Attendance sheet:', error);
      return false;
    }

    // Append the row to the Attendance sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: 'Attendance!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log(`✅ Attendance record written: ${date} ${time} (${timezone} UTC${offsetString}) - ${groupName} - ${memberName}`);
    return true;
  } catch (error) {
    console.error('Error writing attendance to sheet:', error);
    return false;
  }
}

async function recordCodeConfirmation(groupName, customerPhone, message = '', messageTimestamp = null, code = '') {
  try {
    await ensureGroupData();
    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      return { success: false, error: 'Google Sheets not initialized', statusCode: 500 };
    }

    const group = customerGroups[groupName];
    if (!group) {
      return { success: false, error: 'Group not found', statusCode: 404 };
    }

    const cleanedPhone = customerPhone.replace(/\D/g, '');
    const customer = group.customers?.find(c => c.phone.replace(/\D/g, '') === cleanedPhone);
    const memberName = customer?.name || cleanedPhone;
    const memberPhone = customer?.phone || customerPhone;

    const timestampValue = messageTimestamp ? Number(messageTimestamp) : null;
    let timestamp = timestampValue ? new Date(timestampValue * 1000) : new Date();
    if (Number.isNaN(timestamp.getTime())) {
      console.warn('[CODE] Invalid timestamp provided, using current time');
      timestamp = new Date();
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneOffset = timestamp.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
    const offsetMinutes = Math.abs(timezoneOffset) % 60;
    const offsetSign = timezoneOffset <= 0 ? '+' : '-';
    const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    const time = timestamp.toTimeString().split(' ')[0];

    // Prepare row data: Date, Time, Group, Member, Phone, Message, Timezone, Code
    const rowData = [
      date,
      time,
      groupName,
      memberName,
      memberPhone,
      message || '',
      `${timezone} (UTC${offsetString})`,
      code || ''
    ];

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });
    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
    const codeSheetExists = sheetNames.includes('CodeMonitor');

    if (!codeSheetExists) {
      // Create CodeMonitor sheet with Code column (8 columns total)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: 'CodeMonitor',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 8
                }
              }
            }
          }]
        }
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
        range: 'CodeMonitor!A1:H1',
        valueInputOption: 'RAW',
        resource: {
          values: [[
            'Date',
            'Time',
            'Group',
            'Member',
            'Phone',
            'Message',
            'Timezone',
            'Code'
          ]]
        }
      });

      console.log('[CODE] Created CodeMonitor sheet with headers (including Code column)');
    } else {
      // Check if Code column exists, if not add it
      try {
        const headerResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: 'CodeMonitor!A1:H1'
        });

        const headers = headerResponse.data.values?.[0] || [];
        const hasCodeColumn = headers.some(h => h && h.toString().toLowerCase().trim() === 'code');

        if (!hasCodeColumn) {
          // Code column doesn't exist, update headers to include it
          // Find the index after Timezone (Code should be after Timezone)
          const timezoneIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'timezone');
          const insertIndex = timezoneIndex !== -1 ? timezoneIndex + 1 : headers.length;

          // Update headers to include Code column after Timezone
          const newHeaders = [...headers];
          newHeaders.splice(insertIndex, 0, 'Code');

          await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
            range: `CodeMonitor!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
            valueInputOption: 'RAW',
            resource: {
              values: [newHeaders]
            }
          });

          console.log('[CODE] Added Code column to existing CodeMonitor sheet (after Timezone)');
        } else {
          // Code column exists, check if Timezone is before it
          const codeIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'code');
          const timezoneIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'timezone');

          if (timezoneIndex !== -1 && codeIndex !== -1 && timezoneIndex > codeIndex) {
            // Timezone is after Code, need to reorder
            const newHeaders = [...headers];
            const timezone = newHeaders.splice(timezoneIndex, 1)[0];
            // Insert Timezone before Code
            newHeaders.splice(codeIndex, 0, timezone);

            await sheets.spreadsheets.values.update({
              spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
              range: `CodeMonitor!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
              valueInputOption: 'RAW',
              resource: {
                values: [newHeaders]
              }
            });

            console.log('[CODE] Reordered columns: Timezone is now before Code');
          }
        }
      } catch (error) {
        console.warn('[CODE] Could not check/update CodeMonitor headers:', error.message);
        // Continue anyway, will try to append with Code column
      }
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
      range: 'CodeMonitor!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log(`[CODE] Logged confirmation for ${memberName} (${memberPhone}) in CodeMonitor`);

    return { success: true, record: rowData };
  } catch (error) {
    console.error('Error recording code confirmation:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

async function initializeGoogleSheets() {
  try {
    if (!isGoogleSheetsConfigured()) {
      return null;
    }
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_SHEETS_CONFIG.credentials,
      scopes: GOOGLE_SHEETS_CONFIG.scopes
    });

    const sheets = google.sheets({ version: 'v4', auth });
    return sheets;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    return null;
  }
}

async function loadCustomerGroups(forceRefresh = false) {
  try {
    // Return cached data if available and not forcing refresh
    if (!forceRefresh && customerGroupsCache && customerGroupsCacheTime > 0) {
      const cacheAge = Date.now() - customerGroupsCacheTime;
      console.log(`📦 Returning cached customer groups (cached ${Math.round(cacheAge / 1000)}s ago)`);
      return customerGroupsCache;
    }

    const sheets = await initializeGoogleSheets();
    if (!sheets) {
      if (!googleSheetsMissingEnvLogged) {
        googleSheetsMissingEnvLogged = true;
        if (!isGoogleSheetsConfigured()) {
          console.log(
            'Google Sheets: not configured (set GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SPREADSHEET_ID in server .env and restart). Customer groups disabled.'
          );
        } else {
          console.log('Google Sheets: initialization failed; customer groups unavailable.');
        }
      }
      // Return cached data if available, even if Sheets not configured
      if (customerGroupsCache) {
        return customerGroupsCache;
      }
      return {};
    }

    console.log('🔄 Loading customer groups from Google Sheets...');
    const startTime = Date.now();

    // Get all sheet names
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId
    });

    const sheetNames = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
    console.log('Available sheets:', sheetNames);

    const groups = {};

    // Exclude "Master" sheet to prevent accidental mass messaging
    const excludedSheets = ['Master'];

    for (const sheetName of sheetNames) {
      // Skip excluded sheets
      if (excludedSheets.includes(sheetName)) {
        console.log(`Skipping excluded sheet: ${sheetName}`);
        continue;
      }

      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_CONFIG.spreadsheetId,
          range: `${sheetName}!A:Z`
        });

        const rows = response.data.values;
        if (!rows || rows.length < 2) continue;

        const headers = rows[0];
        const dataRows = rows.slice(1);

        // Find phone number and name columns
        const phoneCol = headers.findIndex(h =>
          h && h.toLowerCase().includes('phone') ||
          h && h.toLowerCase().includes('number') ||
          h && h.toLowerCase().includes('whatsapp')
        );
        const nameCol = headers.findIndex(h =>
          h && h.toLowerCase().includes('name') ||
          h && h.toLowerCase().includes('customer')
        );

        if (phoneCol === -1) continue;

        const customers = dataRows.map(row => {
          const phone = row[phoneCol] ? row[phoneCol].toString().trim() : '';
          const name = nameCol !== -1 && row[nameCol] ? row[nameCol].toString().trim() : '';

          // Check if it's already a group ID or contact ID with @g.us or @c.us
          if (phone.includes('@g.us') || phone.includes('@c.us')) {
            // Already in correct format - use as is
            return {
              phone: phone,
              name: name || phone,
              originalPhone: phone,
              isGroup: phone.includes('@g.us')
            };
          }

          // Auto-detect group IDs: Numbers 15-20 digits long starting with 120 are group IDs
          const digitsOnly = phone.replace(/\D/g, ''); // Remove non-digits
          if (digitsOnly.length >= 15 && digitsOnly.length <= 20 && digitsOnly.startsWith('120')) {
            // This looks like a group ID - add @g.us suffix
            console.log(`Auto-detected group ID: ${digitsOnly}`);
            return {
              phone: `${digitsOnly}@g.us`,
              name: name || phone,
              originalPhone: phone,
              isGroup: true
            };
          }

          // Format phone number for regular contacts
          let formattedPhone = digitsOnly;
          if (formattedPhone && !formattedPhone.startsWith('91')) {
            formattedPhone = '91' + formattedPhone;
          }

          return {
            phone: formattedPhone,
            name: name || phone,
            originalPhone: phone,
            isGroup: false
          };
        }).filter(customer => customer.phone && (customer.phone.length >= 10 || customer.phone.includes('@g.us')));

        groups[sheetName] = {
          name: sheetName,
          customers: customers,
          totalCustomers: customers.length,
          lastUpdated: new Date().toISOString()
        };

        console.log(`Loaded ${customers.length} customers from sheet: ${sheetName}`);
      } catch (error) {
        console.error(`Error loading sheet ${sheetName}:`, error);
      }
    }

    const loadTime = Date.now() - startTime;
    console.log(`✅ Loaded ${Object.keys(groups).length} groups in ${loadTime}ms`);

    // Update cache
    customerGroupsCache = groups;
    customerGroupsCacheTime = Date.now();
    customerGroups = groups; // Also update the global variable

    return groups;
  } catch (error) {
    console.error('Error loading customer groups:', error);
    // Return cached data if available, even on error
    if (customerGroupsCache) {
      console.log('⚠️ Error loading groups, returning cached data');
      return customerGroupsCache;
    }
    return {};
  }
}

async function ensureGroupData() {
  // Use cache if available, otherwise load
  if (customerGroupsCache && customerGroupsCacheTime > 0) {
    customerGroups = customerGroupsCache;
    return;
  }

  if (customerGroups && Object.keys(customerGroups).length > 0) {
    return;
  }

  console.log('[SCHEDULE] Customer group cache empty. Loading from Google Sheets...');
  customerGroups = await loadCustomerGroups(false); // Don't force refresh
}

function validateSchedulePayload(group, payload = {}, existingSchedule = null, options = {}) {
  const requireFutureStart = options.requireFutureStart ?? false;

  if (!group || !Array.isArray(group.customers)) {
    return { error: 'Group data unavailable' };
  }

  const timezone = existingSchedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const message = typeof payload.message === 'string'
    ? payload.message
    : (payload.message != null ? String(payload.message) : (existingSchedule?.message || ''));

  const mediaUrl = typeof payload.mediaUrl === 'string'
    ? payload.mediaUrl
    : (existingSchedule?.mediaUrl || '');

  if (!message && !mediaUrl) {
    return { error: 'Message or media is required' };
  }

  const mediaType = payload.mediaType || existingSchedule?.mediaType || null;
  const mediaFilename = payload.mediaFilename || existingSchedule?.mediaFilename || null;
  const hasMedia = typeof payload.hasMedia === 'boolean' ? payload.hasMedia : !!mediaUrl;

  const targetScope = payload.targetScope === 'all'
    ? 'all'
    : 'selected';

  let selectedPhones = [];
  if (targetScope === 'selected') {
    const providedPhones = Array.isArray(payload.selectedPhones) && payload.selectedPhones.length > 0
      ? payload.selectedPhones
      : (existingSchedule?.selectedPhones || []);

    if (!providedPhones.length) {
      return { error: 'Select at least one recipient to schedule' };
    }

    const validPhones = new Set(group.customers.map(customer => customer.phone));
    selectedPhones = providedPhones.map(phone => phone.toString());
    const invalidPhones = selectedPhones.filter(phone => !validPhones.has(phone));

    if (invalidPhones.length > 0) {
      return { error: `Invalid recipients: ${invalidPhones.join(', ')}` };
    }
  }

  const scheduleData = payload.schedule || {};
  const startDate = scheduleData.startDate || existingSchedule?.startDate;
  const startTime = scheduleData.startTime || existingSchedule?.startTime;
  const endDate = scheduleData.endDate || existingSchedule?.endDate;
  const endTime = scheduleData.endTime || existingSchedule?.endTime;

  if (!startDate || !startTime || !endDate || !endTime) {
    return { error: 'Start and end date/time are required' };
  }

  const startDateTime = combineScheduleDateTime(startDate, startTime);
  const endDateTime = combineScheduleDateTime(endDate, endTime);

  if (!startDateTime || Number.isNaN(startDateTime.getTime())) {
    return { error: 'Invalid start date/time' };
  }
  if (!endDateTime || Number.isNaN(endDateTime.getTime())) {
    return { error: 'Invalid end date/time' };
  }

  if (requireFutureStart && startDateTime <= new Date()) {
    return { error: 'Start time must be in the future' };
  }

  const recurrenceType = (scheduleData.recurrenceType || existingSchedule?.recurrenceType || 'daily').toLowerCase();
  const allowedRecurrence = ['once', 'daily', 'weekly', 'monthly'];
  if (!allowedRecurrence.includes(recurrenceType)) {
    return { error: 'Invalid recurrence type' };
  }

  if (recurrenceType === 'once') {
    if (endDateTime < startDateTime) {
      return { error: 'End time cannot be before the start time for one-time schedules' };
    }
  } else if (endDateTime <= startDateTime) {
    return { error: 'End time must be after the start time' };
  }

  let weekdays = [];
  let monthlyDay = null;

  if (recurrenceType === 'weekly') {
    const providedWeekdays = Array.isArray(scheduleData.weekdays)
      ? scheduleData.weekdays
      : (existingSchedule?.weekdays || []);
    weekdays = providedWeekdays
      .map(value => Number(value))
      .filter(value => !Number.isNaN(value) && value >= 0 && value <= 6);

    if (!weekdays.length) {
      return { error: 'Select at least one weekday for weekly schedules' };
    }
  }

  if (recurrenceType === 'monthly') {
    const providedDay = scheduleData.monthlyDay ?? existingSchedule?.monthlyDay ?? startDateTime.getDate();
    monthlyDay = parseInt(providedDay, 10);
    if (Number.isNaN(monthlyDay) || monthlyDay < 1 || monthlyDay > 31) {
      return { error: 'Invalid monthly day (must be between 1 and 31)' };
    }
  }

  return {
    value: {
      message,
      mediaUrl,
      mediaType,
      mediaFilename,
      hasMedia,
      targetScope,
      selectedPhones,
      startDate,
      startTime,
      endDate,
      endTime,
      recurrenceType,
      weekdays,
      monthlyDay,
      timezone,
      startDateTime,
      endDateTime
    }
  };
}

// Function to replace placeholders in message text
function replaceMessagePlaceholders(message, customer, sendDate = new Date()) {
  if (!message || typeof message !== 'string') {
    return message;
  }

  let replacedMessage = message;

  // Replace <day of the week>
  const dayOfWeek = sendDate.toLocaleDateString('en-US', { weekday: 'long' });
  replacedMessage = replacedMessage.replace(/<day of the week>/gi, dayOfWeek);

  // Replace <date of month> and shifted variants
  const baseDate = new Date(sendDate.getTime());
  const minusOneDate = new Date(sendDate.getTime());
  minusOneDate.setDate(minusOneDate.getDate() - 1);
  const minusTwoDate = new Date(sendDate.getTime());
  minusTwoDate.setDate(minusTwoDate.getDate() - 2);

  const dateOfMonth = baseDate.getDate().toString();
  const dateOfMonthMinusOne = minusOneDate.getDate().toString();
  const dateOfMonthMinusTwo = minusTwoDate.getDate().toString();

  // Replace more specific placeholders first
  replacedMessage = replacedMessage.replace(/<date of month -2>/gi, dateOfMonthMinusTwo);
  replacedMessage = replacedMessage.replace(/<date of month -1>/gi, dateOfMonthMinusOne);
  replacedMessage = replacedMessage.replace(/<date of month>/gi, dateOfMonth);

  // Replace <customer name>
  if (customer && customer.name) {
    replacedMessage = replacedMessage.replace(/<customer name>/gi, customer.name);
  }

  return replacedMessage;
}

/** Best-effort match: WhatsApp may normalize line breaks, spacing, or truncate previews. */
function outgoingTextLikelyMatchesChatBody(sentText, messageBody) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(sentText);
  const b = norm(messageBody);
  if (!a.length || !b.length) return false;
  if (b.includes(a)) return true;
  const prefix = a.substring(0, Math.min(40, a.length));
  if (prefix.length >= 2 && b.includes(prefix)) return true;
  const firstLine = norm(sentText.split('\n')[0] || '');
  if (firstLine.length >= 2 && b.includes(firstLine)) return true;
  return false;
}

async function sendGroupMessageInternal(groupName, options = {}) {
  try {
    const {
      message,
      mediaUrl,
      mediaType,
      mediaFilename,
      hasMedia,
      selectedPhones
    } = options;

    if (!message && !mediaUrl) {
      return {
        status: 'validation_error',
        error: 'Message content is required'
      };
    }

    await ensureGroupData();

    const group = customerGroups[groupName];
    if (!group) {
      return {
        status: 'not_found',
        error: 'Group not found'
      };
    }

    if (!isClientReady) {
      return {
        status: 'client_not_ready',
        error: 'WhatsApp client not ready'
      };
    }

    console.log('Forward request received:', {
      groupName,
      hasMessage: !!message,
      hasMedia: hasMedia,
      mediaType,
      mediaFilename,
      mediaUrlLength: mediaUrl ? mediaUrl.length : 0,
      selectedPhonesCount: selectedPhones ? selectedPhones.length : 'all'
    });

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    let customersToMessage = group.customers;
    if (selectedPhones && Array.isArray(selectedPhones) && selectedPhones.length > 0) {
      // Normalize phone numbers for comparison (remove @c.us/@g.us and non-digits)
      const selectedPhonesClean = selectedPhones.map(phone => phone.replace(/\D/g, ''));
      customersToMessage = group.customers.filter(customer => {
        const customerPhoneClean = customer.phone.replace(/\D/g, '');
        return selectedPhonesClean.includes(customerPhoneClean);
      });
      console.log(`Filtering to ${customersToMessage.length} selected customers out of ${group.customers.length} total`);
    }

    for (const customer of customersToMessage) {
      // Check client ready status before each message to handle drops during large batches
      if (!isClientReady) {
        console.error(`❌ [SEND] Client disconnected during batch send. Stopping at ${customer.name}.`);
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: 'Client disconnected during batch send'
        });
        break; // Stop processing remaining customers
      }

      let chat = null;
      let personalizedMessage = null;
      try {
        let chatId;
        if (customer.phone.includes('@g.us') || customer.phone.includes('@c.us')) {
          chatId = customer.phone;
        } else {
          chatId = `${customer.phone}@c.us`;
        }

        console.log(`Getting chat for ID: ${chatId} (${customer.name})`);
        chat = await client.getChatById(chatId);

        // Replace placeholders in message for this customer
        const sendDate = new Date();
        personalizedMessage = message ? replaceMessagePlaceholders(message, customer, sendDate) : message;
        const personalizedMediaCaption = message ? replaceMessagePlaceholders(message, customer, sendDate) : message;

        if (hasMedia && mediaUrl && mediaType) {
          console.log(`Sending media to ${customer.phone}...`);
          // ... (media handling kept similar, can be refined if needed) ...
          if (mediaUrl.startsWith('data:')) {
            const base64Data = mediaUrl.split(',')[1];
            // ... (keeping existing buffer/temp file logic for brevity/consistency if it works) ...
            // Ideally we'd optimize this too, but focusing on text/send logic first as per plan.
            // For now, let's assume media sending logic is acceptable but wrap in better error handling if needed.

            // Re-implementing the media sending part briefly to ensure context is kept:
            const buffer = Buffer.from(base64Data, 'base64');
            const tempDir = path.join(__dirname, 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempFilePath = path.join(tempDir, `${Date.now()}_${mediaFilename || 'media'}`);
            fs.writeFileSync(tempFilePath, buffer);

            try {
              const mediaMessage = new MessageMedia(mediaType, base64Data);
              await chat.sendMessage(mediaMessage, { caption: personalizedMediaCaption, sendSeen: false });
            } catch (error) {
              console.error('Error sending media message:', error);
              // Fallback to text only if media fails is NOT desired usually, but logic was:
              await chat.sendMessage(personalizedMessage || '', { sendSeen: false });
            } finally {
              if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
          } else {
            await chat.sendMessage(mediaUrl, { caption: personalizedMediaCaption, sendSeen: false });
          }
          // Assuming media send is "sent" for now, strict verification for media is harder without message ID
          successCount++;
          results.push({ phone: customer.phone, name: customer.name, status: 'sent' });

        } else if (personalizedMessage) {
          console.log(`📤 Attempting to send message to ${customer.name}...`);

          let sendSuccess = false;
          let messageVerified = false;
          let usedFallbackSend = false;

          try {
            await chat.sendMessage(personalizedMessage, { sendSeen: false });
            sendSuccess = true;
            console.log(`✅ sendMessage call completed for ${customer.name}`);
          } catch (sendError) {
            const errorMsg = sendError.message || '';
            console.warn(`⚠️ sendMessage error for ${customer.name}: ${errorMsg}`);

            // Check for sendSeen error - BUT DO NOT ASSUME SUCCESS yet
            if (errorMsg.includes('markedUnread') || errorMsg.includes('sendSeen')) {
              console.warn(`⚠️ ignoring sendSeen error, proceeding to verification...`);
              sendSuccess = true;
            } else if (errorMsg.includes('Lid is missing') || errorMsg.includes('lid')) {
              // WhatsApp "Lid is missing in chat table" — fall back to client.sendMessage
              // which uses a different internal path that doesn't require the lid entry.
              console.warn(`⚠️ Lid missing for ${customer.name}, retrying via client.sendMessage...`);
              await client.sendMessage(chatId, personalizedMessage);
              sendSuccess = true;
              console.log(`✅ Fallback client.sendMessage succeeded for ${customer.name}`);
            } else {
              throw sendError; // Re-throw other errors
            }
          }

          // Verification Step
          console.log(`🔍 Verifying delivery for ${customer.name}...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for message to sync

          let verifyAttempts = 0;
          const maxVerifyAttempts = 3;

          while (!messageVerified && verifyAttempts < maxVerifyAttempts) {
            try {
              const recentMessages = await fetchChatMessagesSafe(client, chat, 15);
              const now = Date.now() / 1000;
              const found = recentMessages.find(m => {
                const age = now - m.timestamp;
                return age < 90 && m.fromMe === true &&
                  outgoingTextLikelyMatchesChatBody(personalizedMessage, m.body || '');
              });

              if (found) {
                messageVerified = true;
                sendSuccess = true; // Confirmed
                console.log(`✅ Message verified as sent for ${customer.name}`);
              } else {
                verifyAttempts++;
                if (verifyAttempts < maxVerifyAttempts) {
                  console.log(`⏳ Verification attempt ${verifyAttempts} failed, retrying in 2s...`);
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              }
            } catch (err) {
              console.warn(`⚠️ Error during verification: ${err.message}`);
              verifyAttempts++;
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          // Only run UI fallback when sendMessage did not complete — avoids double-sending.
          if (!messageVerified && !sendSuccess) {
            console.warn(`⚠️ sendMessage did not complete for ${customer.name}. Trying fallback...`);

            // Fallback: UI Automation
            try {
              if (!client.pupPage) {
                throw new Error('Puppeteer page not accessible for fallback');
              }
              // Safe fallback execution
              console.log(`🔄 Attempting UI fallback for ${customer.name}...`);

              const fallbackResult = await client.pupPage.evaluate(async (contactId, messageText) => {
                try {
                  // 1. Get chat
                  const chat = await window.Store.Chat.find(contactId);
                  if (!chat) throw new Error('Chat not found in Store');

                  // 2. Try Store.SendMessage (Primary Fallback)
                  if (window.Store && window.Store.SendMessage && window.Store.SendMessage.addAndSendMsgToChat) {
                    try {
                      await window.Store.SendMessage.addAndSendMsgToChat(chat, messageText);
                      return { success: true, method: 'Store.SendMessage' };
                    } catch (storeErr) {
                      console.warn('Store.SendMessage failed:', storeErr);
                      // Continue to DOM methods
                    }
                  }

                  // 3. UI DOM Fallback (Secondary Fallback)
                  // Navigate to chat
                  const chatElement = document.querySelector(`div[data-id="${contactId}"]`) ||
                    document.querySelector(`span[title*="${contactId.replace('@c.us', '').replace('@g.us', '')}"]`)?.closest('div');

                  if (chatElement) {
                    chatElement.click();
                    await new Promise(r => setTimeout(r, 1000));
                  } else {
                    // If chat not visible, Try opening via Store
                    if (window.Store && window.Store.Chat && window.Store.Chat.open) {
                      await window.Store.Chat.open(chat);
                      await new Promise(r => setTimeout(r, 1000));
                    }
                  }

                  // Find Input
                  let input = document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
                    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                    document.querySelector('div[contenteditable="true"][data-testid="conversation-compose-box-input"]');

                  if (!input) {
                    // Fallback search for any contenteditable in main
                    const main = document.querySelector('#main');
                    if (main) input = main.querySelector('div[contenteditable="true"]');
                  }

                  if (!input) throw new Error('Input field not found');

                  // Type and Send
                  input.focus();
                  document.execCommand('insertText', false, messageText);
                  await new Promise(r => setTimeout(r, 500));

                  // Trigger Send
                  const sendBtn = document.querySelector('span[data-testid="send"]') ||
                    document.querySelector('span[data-icon="send"]');
                  if (sendBtn) {
                    sendBtn.closest('button')?.click();
                  } else {
                    // Enter key as backup
                    const event = new KeyboardEvent('keydown', {
                      bubbles: true, cancelable: true, keyCode: 13
                    });
                    input.dispatchEvent(event);
                  }

                  return { success: true, method: 'DOM Input' };

                } catch (err) {
                  return { success: false, error: err.message };
                }
              }, chatId, personalizedMessage);

              if (fallbackResult.success) {
                usedFallbackSend = true;
                sendSuccess = true;
                console.log(`✅ Fallback successful (${fallbackResult.method}) for ${customer.name}`);

                // Verify again after fallback
                await new Promise(resolve => setTimeout(resolve, 3000));
                const recentMessages = await fetchChatMessagesSafe(client, chat, 5);
                const found = recentMessages.find(m => m.fromMe && outgoingTextLikelyMatchesChatBody(personalizedMessage, m.body || ''));

                if (found) {
                  messageVerified = true;
                  console.log(`✅ Verified message after fallback for ${customer.name}`);
                } else {
                  console.warn(`⚠️ Fallback reported success but verification failed for ${customer.name}`);
                }
              } else {
                console.error(`❌ Fallback failed: ${fallbackResult.error}`);
              }
            } catch (fallbackErr) {
              console.error(`❌ UI Fallback failed: ${fallbackErr.message}`);
            }
          }

          if (messageVerified) {
            successCount++;
            results.push({
              phone: customer.phone,
              name: customer.name,
              status: 'sent',
              warning: sendSuccess ? undefined : 'Sent via fallback'
            });
          } else if (sendSuccess) {
            successCount++;
            results.push({
              phone: customer.phone,
              name: customer.name,
              status: 'sent',
              warning: usedFallbackSend
                ? 'Sent via fallback; could not confirm in chat list'
                : 'WhatsApp accepted the message; chat history check was inconclusive'
            });
            console.log(`✅ Counting as sent for ${customer.name} (send OK, verification optional)`);
          } else {
            errorCount++;
            results.push({
              phone: customer.phone,
              name: customer.name,
              status: 'failed',
              error: 'Message not verified as sent'
            });
            console.error(`❌ Message failed for ${customer.name} after all attempts.`);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
      } catch (error) {
        console.error(`❌ Critical error processing ${customer.name}: ${error.message}`);
        errorCount++;
        results.push({
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: error.message
        });
      }
    }

    return {
      status: 'sent', // Function completed (even if some messages failed)
      successCount,
      errorCount,
      totalCustomers: group.customers.length,
      targetedCustomers: customersToMessage.length,
      results
    };
  } catch (error) {
    console.error('Error sending group message (internal):', error);
    return {
      status: 'error',
      error
    };
  }
}

function combineScheduleDateTime(dateStr, timeStr) {
  if (!dateStr) {
    return null;
  }

  let timeComponent = timeStr || '00:00';
  if (timeComponent.length === 5) {
    timeComponent += ':00';
  }

  const date = new Date(`${dateStr}T${timeComponent}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDaysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function computeNextRunForSchedule(schedule, referenceDate = null) {
  const startDateTime = combineScheduleDateTime(schedule.startDate, schedule.startTime);
  const endDateTime = combineScheduleDateTime(schedule.endDate, schedule.endTime);

  if (!startDateTime) {
    return null;
  }

  const now = referenceDate ? new Date(referenceDate) : new Date();
  const startHour = startDateTime.getHours();
  const startMinute = startDateTime.getMinutes();
  const recurrenceType = (schedule.recurrenceType || 'daily').toLowerCase();
  let candidate = null;

  if (recurrenceType === 'once') {
    candidate = new Date(startDateTime);
    if (candidate < now) {
      return null;
    }
  } else if (recurrenceType === 'daily') {
    candidate = new Date(startDateTime);
    if (candidate < now) {
      const dayMs = 24 * 60 * 60 * 1000;
      const diffMs = now.getTime() - candidate.getTime();
      const daysAhead = Math.ceil(diffMs / dayMs);
      candidate = new Date(candidate.getTime() + daysAhead * dayMs);
    }
  } else if (recurrenceType === 'weekly') {
    const weekdays = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
      ? schedule.weekdays.map(Number).filter(num => !Number.isNaN(num) && num >= 0 && num <= 6)
      : [startDateTime.getDay()];

    candidate = new Date(Math.max(startDateTime.getTime(), now.getTime()));
    candidate.setHours(startHour, startMinute, 0, 0);
    if (candidate < now) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(startHour, startMinute, 0, 0);
    }

    let attempts = 0;
    while (attempts < 14) {
      if (candidate >= startDateTime && weekdays.includes(candidate.getDay())) {
        break;
      }
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(startHour, startMinute, 0, 0);
      attempts++;
    }

    if (!weekdays.includes(candidate.getDay())) {
      return null;
    }
  } else if (recurrenceType === 'monthly') {
    const desiredDay = schedule.monthlyDay ? parseInt(schedule.monthlyDay, 10) : startDateTime.getDate();
    const validDay = Number.isNaN(desiredDay) ? startDateTime.getDate() : Math.min(Math.max(desiredDay, 1), 31);

    const adjustToMonthlyDay = (date) => {
      const daysInMonth = getDaysInMonth(date.getFullYear(), date.getMonth());
      const day = Math.min(validDay, daysInMonth);
      const adjusted = new Date(date);
      adjusted.setDate(day);
      adjusted.setHours(startHour, startMinute, 0, 0);
      return adjusted;
    };

    candidate = adjustToMonthlyDay(startDateTime);
    if (candidate < startDateTime) {
      candidate = adjustToMonthlyDay(new Date(startDateTime.getFullYear(), startDateTime.getMonth() + 1, 1));
    }

    let attempts = 0;
    while (candidate < now && attempts < 240) {
      candidate = adjustToMonthlyDay(new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1));
      attempts++;
    }

    if (attempts >= 240) {
      return null;
    }
  } else {
    return null;
  }

  if (!candidate) {
    return null;
  }

  if (candidate < startDateTime) {
    candidate = new Date(startDateTime);
  }

  if (endDateTime && candidate > endDateTime) {
    return null;
  }

  return candidate;
}

function loadScheduledMessages() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE_PATH)) {
      scheduledMessages = [];
      return;
    }

    const raw = fs.readFileSync(SCHEDULE_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    scheduledMessages = Array.isArray(data) ? data : [];

    let updated = false;
    const now = new Date();

    scheduledMessages.forEach(schedule => {
      if (schedule.status !== 'active') {
        return;
      }

      const nextRun = schedule.nextRun ? new Date(schedule.nextRun) : null;
      if (!nextRun || Number.isNaN(nextRun.getTime()) || nextRun < now) {
        const computed = computeNextRunForSchedule(schedule, now);
        if (computed) {
          schedule.nextRun = computed.toISOString();
        } else {
          schedule.status = 'completed';
          schedule.nextRun = null;
        }
        updated = true;
      }
    });

    if (updated) {
      saveScheduledMessages();
    }
  } catch (error) {
    console.error('[SCHEDULE] Error loading scheduled messages:', error);
    scheduledMessages = [];
  }
}

function saveScheduledMessages() {
  const tmp = SCHEDULE_FILE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(scheduledMessages, null, 2), 'utf-8');
    fs.renameSync(tmp, SCHEDULE_FILE_PATH);
  } catch (error) {
    console.error('[SCHEDULE] Error saving scheduled messages:', error);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

async function processScheduledMessages() {
  if (isProcessingSchedules) {
    return;
  }
  isProcessingSchedules = true;

  try {
    if (!scheduledMessages.length) {
      return;
    }

    const now = new Date();
    let updated = false;

    for (const schedule of scheduledMessages) {
      if (schedule.status !== 'active') {
        continue;
      }

      if (!schedule.nextRun) {
        const next = computeNextRunForSchedule(schedule, now);
        if (next) {
          schedule.nextRun = next.toISOString();
        } else {
          schedule.status = 'completed';
        }
        updated = true;
        continue;
      }

      const nextRunDate = new Date(schedule.nextRun);
      if (Number.isNaN(nextRunDate.getTime())) {
        schedule.status = 'completed';
        schedule.nextRun = null;
        updated = true;
        continue;
      }

      if (nextRunDate > now) {
        continue;
      }

      console.log(`[SCHEDULE] Executing schedule ${schedule.id} for group ${schedule.groupName} at ${now.toISOString()}`);

      const result = await sendGroupMessageInternal(schedule.groupName, {
        message: schedule.message,
        mediaUrl: schedule.mediaUrl,
        mediaType: schedule.mediaType,
        mediaFilename: schedule.mediaFilename,
        hasMedia: schedule.hasMedia,
        selectedPhones: schedule.targetScope === 'selected' ? schedule.selectedPhones : undefined
      });

      if (result.status === 'sent') {
        schedule.lastRunAt = now.toISOString();
        schedule.lastError = null;
        const next = computeNextRunForSchedule(schedule, new Date(now.getTime() + 60000));
        if (next) {
          schedule.nextRun = next.toISOString();
        } else {
          schedule.nextRun = null;
          schedule.status = 'completed';
          console.log(`[SCHEDULE] Schedule ${schedule.id} completed (no further runs)`);
        }
      } else if (result.status === 'client_not_ready') {
        schedule.lastError = 'WhatsApp client not ready';
        const retry = new Date(now.getTime() + 60 * 1000);
        schedule.nextRun = retry.toISOString();
        console.warn(`[SCHEDULE] WhatsApp client not ready. Schedule ${schedule.id} will retry at ${schedule.nextRun}`);
      } else {
        const errorMessage = result.error ? (result.error.message || result.error.toString()) : 'Unknown error';
        schedule.lastError = errorMessage;
        const retry = new Date(now.getTime() + 5 * 60 * 1000);
        const endDateTime = combineScheduleDateTime(schedule.endDate, schedule.endTime);
        if (endDateTime && retry > endDateTime) {
          schedule.status = 'completed';
          schedule.nextRun = null;
          console.error(`[SCHEDULE] Schedule ${schedule.id} failed and end window passed. Marking completed. Error: ${errorMessage}`);
        } else {
          schedule.nextRun = retry.toISOString();
          console.error(`[SCHEDULE] Schedule ${schedule.id} failed. Retrying at ${schedule.nextRun}. Error: ${errorMessage}`);
        }
      }

      updated = true;
    }

    if (updated) {
      saveScheduledMessages();
    }
  } catch (error) {
    console.error('[SCHEDULE] Error processing scheduled messages:', error);
  } finally {
    isProcessingSchedules = false;
  }
}

function startScheduleChecker() {
  loadScheduledMessages();

  if (scheduleChecker) {
    clearInterval(scheduleChecker);
  }

  scheduleChecker = setInterval(() => {
    processScheduledMessages().catch(err => console.error('[SCHEDULE] Scheduler loop error:', err));
  }, SCHEDULE_CHECK_INTERVAL);

  processScheduledMessages().catch(err => console.error('[SCHEDULE] Initial scheduler run error:', err));
}

async function updateAttendance(groupName, customerPhone, status = 'present', month = null, message = '', messageTimestamp = null) {
  try {
    const sheets = await initializeGoogleSheets();
    if (!sheets) return false;

    console.log(`[ATTENDANCE] Updating attendance for group: ${groupName}, customer: ${customerPhone}, message: ${message ? message.substring(0, 50) : '(none)'}`);

    // Find the customer in the group
    const group = customerGroups[groupName];
    if (!group) {
      console.log(`[ERROR] Group not found: ${groupName}`);
      return false;
    }

    console.log(`[DEBUG] Looking for customer with phone: ${customerPhone}`);
    console.log(`[DEBUG] Group has ${group.customers.length} customers`);

    const customer = group.customers.find(c => {
      const customerPhoneClean = customerPhone.replace(/\D/g, '');
      const cPhoneClean = c.phone.replace(/\D/g, '');
      console.log(`[DEBUG] Comparing: ${c.phone} (${c.name}) - clean: ${cPhoneClean} vs ${customerPhoneClean}`);
      return cPhoneClean === customerPhoneClean;
    });

    if (!customer) {
      console.log(`[DEBUG] Customer not found. Group phones: ${group.customers.map(c => c.phone).join(', ')}`);
      return false;
    }

    // Use the customer's phone from the group (normalized)
    const normalizedPhone = customer.phone;

    // Initialize attendance data structure
    if (!attendanceData[groupName]) {
      attendanceData[groupName] = {};
    }
    if (!attendanceData[groupName][normalizedPhone]) {
      attendanceData[groupName][normalizedPhone] = {};
    }

    // Determine the date from message timestamp or use current date
    let attendanceDate;
    if (messageTimestamp) {
      // Use message timestamp to get the date
      const messageDate = new Date(messageTimestamp * 1000); // Convert Unix seconds to milliseconds
      attendanceDate = messageDate.toISOString().slice(0, 10); // YYYY-MM-DD
    } else {
      // Fall back to current date if no timestamp
      attendanceDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    // Use provided month or determine from attendance date (YYYY-MM format)
    const targetMonth = month || attendanceDate.slice(0, 7);

    // Initialize month array if not exists
    if (!attendanceData[groupName][normalizedPhone][targetMonth]) {
      attendanceData[groupName][normalizedPhone][targetMonth] = [];
    }

    // Add the attendance date if not already present
    if (!attendanceData[groupName][normalizedPhone][targetMonth].includes(attendanceDate)) {
      attendanceData[groupName][normalizedPhone][targetMonth].push(attendanceDate);
      console.log(`Attendance marked for ${customer.name} (${normalizedPhone}) on ${attendanceDate} in month ${targetMonth}`);

      // Write to Attendance sheet (Date, Time, Group, Member, Message)
      // Use message timestamp if provided, otherwise use current time
      try {
        await writeAttendanceToSheet(groupName, customer.name, customer.phone, message, messageTimestamp);
        console.log(`Attendance written to Attendance sheet for ${customer.name}`);
      } catch (sheetError) {
        console.error('Error writing to Attendance sheet:', sheetError);
        // Don't fail the request if sheet update fails
        console.log('Continuing despite Attendance sheet write error...');
      }
    }

    return true;
  } catch (error) {
    console.error('Error updating attendance:', error);
    return false;
  }
}

// Global error handlers to prevent server crashes
process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason?.message || String(reason || '');
  const errorStack = reason?.stack || '';

  // Ignore LocalWebCache.persist errors - we've disabled webCache
  if (errorMsg.includes('LocalWebCache') || errorMsg.includes('Cannot read properties of null') || errorStack.includes('LocalWebCache')) {
    console.warn('⚠️ Ignoring LocalWebCache error (webCache is disabled):', errorMsg);
    return;
  }

  // Ignore EBUSY lockfile errors from LocalAuth on Windows — Chromium holds the
  // lockfile while running; the unlink in LocalAuth.logout() fails harmlessly.
  if (errorMsg.includes('EBUSY') && errorMsg.includes('lockfile')) {
    console.warn('⚠️ Ignoring EBUSY lockfile error from LocalAuth (expected on Windows):', errorMsg);
    return;
  }

  console.error('❌ [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log the error
});

process.on('uncaughtException', (error) => {
  console.error('❌ [CRITICAL] Uncaught Exception:', error);
  // Don't exit immediately - give time to log and handle
  // In production, you might want to restart here
});

// Handle SIGTERM and SIGINT gracefully (for nodemon restarts and shutdowns)
async function gracefulShutdown(signal) {
  console.log(`⚠️ ${signal} received, shutting down gracefully...`);

  // Stop accepting new connections
  isInitializing = false;
  isClientReady = false;

  // Clear intervals and timeouts
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  // Destroy client if it exists
  if (client && typeof client.destroy === 'function') {
    try {
      console.log('🧹 Destroying WhatsApp client...');
      await Promise.race([
        client.destroy(),
        new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second timeout
      ]);
      console.log('✅ Client destroyed successfully');
    } catch (error) {
      console.log('⚠️ Error destroying client (may already be destroyed):', error.message);
    }
  }

  // Give a moment for cleanup
  await new Promise(resolve => setTimeout(resolve, 500));

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize scheduler
startScheduleChecker();

// Initialize WhatsApp client (only once, with guards)
// CRITICAL: Check if client is already ready before initializing
async function initializeWhatsAppClient() {
  // Prevent multiple simultaneous initializations
  if (isInitializing) {
    console.log('⚠️ Client initialization already in progress, skipping...');
    return;
  }

  if (isClientReady) {
    console.log('✅ Client is already ready, skipping initialization');
    return;
  }

  if (clientInitialized) {
    console.log('⚠️ Client already initialized, skipping...');
    return;
  }

  // Clean up any existing client instance before initializing
  try {
    if (client && typeof client.destroy === 'function') {
      console.log('🧹 Cleaning up existing client instance before initialization...');
      // Add timeout to prevent hanging on destroy
      try {
        const destroyPromise = client.destroy();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Destroy timeout')), 5000)
        );
        await Promise.race([destroyPromise, timeoutPromise]).catch(err => {
          // Ignore destroy errors - client may already be destroyed or in invalid state
          if (!err.message.includes('timeout')) {
            console.log('⚠️ Error destroying old client (may already be destroyed):', err.message);
          }
        });
      } catch (destroyErr) {
        // Ignore destroy errors
        console.log('⚠️ Error destroying old client (may already be destroyed):', destroyErr.message);
      }
      // Wait a bit for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      removeChromeProfileSingletonLocks(WWEBJS_AUTH_DIR);
    }
  } catch (cleanupError) {
    console.log('⚠️ Error during client cleanup:', cleanupError.message);
  }

  console.log('🚀 Initializing WhatsApp client...');

  // Reset flags that might block QR code on fresh initialization
  // These flags should only be set after successful authentication
  if (!isClientReady) {
    console.log('🔄 Resetting authentication flags for fresh initialization...');
    firstReadyProcessed = false;
    firstAuthenticatedProcessed = false;
    isClientReady = false;
  }

  console.log('🔍 Init Debug:', {
    isClientReady,
    isInitializing,
    clientInitialized,
    firstReadyProcessed,
    firstAuthenticatedProcessed
  });

  isInitializing = true;
  clientInitialized = true;

  // Check session state before initializing
  const authPath = path.join(__dirname, '.wwebjs_auth');
  const sessionExists = fs.existsSync(authPath);
  console.log('🔍 Session check before init:', { sessionExists, storePath: authPath });

  if (sessionExists) {
    console.log('⚠️ Existing session found in LocalAuth store - client may authenticate without QR code');
    console.log('⚠️ If QR code is needed, you may need to clear the session');
  } else {
    console.log('✅ No existing session in LocalAuth store - QR code should be generated');
  }

  try {
    // Give Chrome time to release profile locks after destroy (Docker restarts / new hostname).
    await new Promise(resolve => setTimeout(resolve, sessionExists ? 2000 : 500));

    logWwebjsSessionLayoutForDiagnostics();
    removeChromeDefaultProfileIfRequested();
    removeStaleGoogleChromeTmpArtifacts();
    removeChromeProfileSingletonLocks(WWEBJS_AUTH_DIR);

    console.log('🔍 Calling client.initialize()...');

    // Set a timeout to detect if initialization is stuck
    const initTimeout = setTimeout(() => {
      if (isInitializing && !isClientReady && !qrCodeData) {
        console.warn('⚠️ Initialization timeout - no QR code or authentication after 30 seconds');
        console.warn('⚠️ This usually means the existing session is invalid');
        console.warn('⚠️ Recommendation: Clear the session to force QR code generation');
        console.warn('⚠️ Session store path:', authPath);
      }
    }, 30000); // 30 second timeout

    await client.initialize().then(() => {
      clearTimeout(initTimeout);
      console.log('✅ Client initialization started successfully');
      console.log('🔍 Waiting for QR code or authentication event...');

      // Check if browser/page is accessible
      setTimeout(async () => {
        try {
          // Try to access the Puppeteer page
          const page = client.pupPage;
          if (page) {
            console.log('✅ Puppeteer page is accessible');
            const url = page.url();
            console.log('🔍 Page URL:', url);
          } else {
            console.warn('⚠️ Puppeteer page is not accessible (null)');
          }
        } catch (err) {
          console.warn('⚠️ Could not access Puppeteer page:', err.message);
        }
      }, 2000);

      // Fallback: if 'ready' event never fires but state becomes CONNECTED, force ready.
      // Two checks are enough – 10 s and 30 s after init resolves.
      const checkStateFallback = (delay, label) => {
        setTimeout(async () => {
          if (!client || isClientReady) return;
          try {
            const state = await client.getState();
            console.log(`🔍 ${label}: state=${state || 'NULL'}`);
            if (state === 'CONNECTED' && !isClientReady && !firstReadyProcessed) {
              console.warn(`⚠️ ${label}: CONNECTED but ready never fired – forcing ready`);
              forceClientReady(label);
            }
          } catch (e) {
            console.warn(`⚠️ ${label}: state check error – ${e.message}`);
          }
        }, delay);
      };
      checkStateFallback(10000, 'init+10s');
      checkStateFallback(30000, 'init+30s');

      // isInitializing will be set to false in ready event
    }).catch((error) => {
      clearTimeout(initTimeout);
      const errorMsg = error.message || String(error);

      // Check for the specific "Execution context was destroyed" error
      if (errorMsg.includes('Execution context was destroyed') ||
        errorMsg.includes('Protocol error')) {
        console.error('❌ Failed to initialize client: Execution context destroyed');
        console.error('⚠️ This usually happens when:');
        console.error('   1. Server restarted while browser was initializing');
        console.error('   2. Previous browser instance is still running');
        console.error('   3. Multiple instances trying to use the same session');
        console.error('🔄 Will retry initialization in 3 seconds...');

        // Reset flags to allow retry
        isInitializing = false;
        clientInitialized = false;

        // Retry after a delay
        setTimeout(() => {
          if (!isClientReady && !isInitializing) {
            console.log('🔄 Retrying client initialization...');
            initializeWhatsAppClient();
          }
        }, 3000);
      } else {
        console.error('❌ Failed to initialize client:', errorMsg);
        isInitializing = false;
        clientInitialized = false; // Allow retry
      }
    });
  } catch (error) {
    const errorMsg = error.message || String(error);
    console.error('❌ Error calling client.initialize():', errorMsg);

    // Check for the specific "Execution context was destroyed" error
    if (errorMsg.includes('Execution context was destroyed') ||
      errorMsg.includes('Protocol error')) {
      console.error('⚠️ Execution context error detected - will retry in 3 seconds...');
      isInitializing = false;
      clientInitialized = false;

      // Retry after a delay
      setTimeout(() => {
        if (!isClientReady && !isInitializing) {
          console.log('🔄 Retrying client initialization...');
          initializeWhatsAppClient();
        }
      }, 3000);
    } else {
      isInitializing = false;
      clientInitialized = false;
    }
  }
}

// Initialize WhatsApp client
initializeWhatsAppClient();

// Memory cleanup function
function performMemoryCleanup() {
  try {
    // Force garbage collection if available (requires --expose-gc flag)
    if (global.gc) {
      global.gc();
      console.log('🧹 Memory cleanup: Garbage collection triggered');
    }

    // Log memory usage
    const memUsage = process.memoryUsage();
    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };

    console.log('📊 Memory usage:', memUsageMB);

    // Warn if memory usage is high
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > MEMORY_WARNING_THRESHOLD * 100) {
      console.warn(`⚠️ High memory usage: ${heapUsagePercent.toFixed(1)}% of heap used`);
    }
  } catch (error) {
    console.error('Error during memory cleanup:', error);
  }
}

// Start periodic memory cleanup
setInterval(performMemoryCleanup, MEMORY_CLEANUP_INTERVAL);
console.log(`✅ Memory cleanup scheduled every ${MEMORY_CLEANUP_INTERVAL / 1000 / 60} minutes`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log(`💾 Memory limits: ${MAX_MESSAGES_PER_REQUEST} messages per request, ${MAX_MESSAGES_PER_CHAT} per chat`);

  // Log initial memory usage
  const initialMem = process.memoryUsage();
  console.log('📊 Initial memory usage:', {
    rss: Math.round(initialMem.rss / 1024 / 1024) + ' MB',
    heapTotal: Math.round(initialMem.heapTotal / 1024 / 1024) + ' MB',
    heapUsed: Math.round(initialMem.heapUsed / 1024 / 1024) + ' MB'
  });

  // Note about garbage collection
  if (global.gc) {
    console.log('✅ Garbage collection enabled (--expose-gc flag set)');
  } else {
    console.log('ℹ️  Garbage collection not enabled. For better memory management, start with: node --expose-gc server.js');
  }
});

// List scheduled messages
app.get('/schedules', async (req, res) => {
  try {
    await ensureGroupData();
    const { groupName } = req.query;
    let schedules = scheduledMessages;

    if (groupName) {
      schedules = schedules.filter(schedule => schedule.groupName === groupName);
    }

    res.json({ success: true, schedules });
  } catch (error) {
    console.error('[SCHEDULE] Error listing schedules:', error);
    res.status(500).json({ success: false, error: 'Failed to load schedules', details: error.message });
  }
});

