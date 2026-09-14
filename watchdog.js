'use strict';

/**
 * wa-manager watchdog.
 *
 * The WhatsApp Puppeteer/Chrome session sometimes crashes silently while the
 * node process (and its own internal "ready" state) stays alive — every API
 * call then fails with "Attempted to use detached Frame ...".
 *
 * This polls a real, page-touching endpoint (/api/chat-messages/chats, which
 * calls client.getChats() and therefore genuinely exercises the browser) on
 * an interval. If it sees the detached-frame signature on CONSECUTIVE_NEEDED
 * checks in a row (to ignore single transient blips), it restarts the
 * wa-manager PM2 process. A cooldown prevents restart loops.
 */

const http = require('http');
const { exec } = require('child_process');

const CHECK_INTERVAL_MS  = 30_000;   // poll every 30s
const COOLDOWN_MS        = 120_000;  // never restart more than once per 2 min
const CONSECUTIVE_NEEDED = 2;        // require 2 bad checks in a row before acting
const HEALTH_PATH        = '/api/chat-messages/chats';
const HEALTH_PORT        = 3001;

let consecutiveBad = 0;
let lastRestart     = 0;

function checkHealth() {
  const req = http.get(
    { host: '127.0.0.1', port: HEALTH_PORT, path: HEALTH_PATH, timeout: 8000 },
    (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const crashed = body.includes('detached Frame');
        if (crashed) {
          consecutiveBad++;
          console.log(`[Watchdog] Unhealthy check ${consecutiveBad}/${CONSECUTIVE_NEEDED} — detached frame detected`);
          if (consecutiveBad >= CONSECUTIVE_NEEDED) _maybeRestart();
        } else {
          if (consecutiveBad > 0) console.log('[Watchdog] Recovered — resetting counter');
          consecutiveBad = 0;
        }
      });
    }
  );
  req.on('timeout', () => { req.destroy(); console.log('[Watchdog] Health check timed out'); });
  req.on('error', (err) => { console.log('[Watchdog] Health check error:', err.message); });
}

function _maybeRestart() {
  const now = Date.now();
  if (now - lastRestart < COOLDOWN_MS) {
    console.log('[Watchdog] Restart needed but still in cooldown — skipping');
    return;
  }
  lastRestart = now;
  consecutiveBad = 0;
  console.log('[Watchdog] Restarting wa-manager due to detached-frame crash');
  exec('pm2 restart wa-manager', (err) => {
    if (err) console.error('[Watchdog] pm2 restart command failed:', err.message);
    else console.log('[Watchdog] pm2 restart command issued successfully');
  });
}

console.log(`[Watchdog] Started. Polling ${HEALTH_PATH} every ${CHECK_INTERVAL_MS / 1000}s.`);
setInterval(checkHealth, CHECK_INTERVAL_MS);
checkHealth();
