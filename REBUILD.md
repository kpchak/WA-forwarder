# WA Customer Manager — Rebuild Spec

## What It Does

| Feature | Description |
|---|---|
| Group management | Fetch customer groups from Google Sheets (dynamic) |
| Send messages | Text + media/attachments to any group |
| Forward messages | Forward received messages (with or without caption) |
| Scheduled messages | Daily / weekly / monthly with time picker |
| Message viewer | Read group chat history, filter by date/sender |
| Attendance | Auto-parse codes from incoming messages + manual marking |

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | Same as existing, stable |
| WhatsApp | whatsapp-web.js | Proven, works with LocalAuth |
| Web framework | Express | Minimal, familiar |
| Realtime | Socket.IO (WebSocket only) | Remove polling — it breaks through Nginx |
| Database | SQLite via `better-sqlite3` | No separate process, file-based, fast |
| Scheduler | `node-cron` | Simple cron syntax, in-process |
| Google Sheets | `googleapis` | Official SDK |
| Process manager | PM2 | Auto-restart, logs |
| Reverse proxy | Nginx | SSL termination, WebSocket proxy |

---

## File Structure

```
wa-manager/
├── server.js                  # Entry point, Express + Socket.IO setup
├── ecosystem.config.js        # PM2 config
├── .env                       # Secrets (never commit)
├── .env.example
│
├── src/
│   ├── whatsapp/
│   │   ├── client.js          # Single WhatsApp client, lifecycle management
│   │   └── events.js          # All client.on() listeners in one place
│   │
│   ├── services/
│   │   ├── sheets.js          # Google Sheets fetch + cache
│   │   ├── scheduler.js       # node-cron job management
│   │   └── attendance.js      # Attendance parsing + storage
│   │
│   ├── routes/
│   │   ├── messages.js        # POST /api/send, POST /api/forward
│   │   ├── groups.js          # GET /api/groups
│   │   ├── schedule.js        # CRUD /api/schedules
│   │   └── attendance.js      # GET/POST /api/attendance
│   │
│   └── db/
│       ├── index.js           # DB connection singleton
│       └── schema.sql         # Table definitions
│
└── public/
    ├── index.html
    ├── app.js                 # Socket.IO client + UI logic
    └── style.css
```

---

## Critical Architecture Rules

### 1. WhatsApp client — never re-initialize the same instance

```js
// src/whatsapp/client.js
const { Client, LocalAuth } = require('whatsapp-web.js');

let client = null;
let status = 'stopped'; // stopped | initializing | ready | disconnected

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });
  return client;
}

async function start() {
  if (status === 'initializing' || status === 'ready') return;
  status = 'initializing';
  // Always create a NEW client instance — never call initialize()
  // twice on the same instance (causes onQRChangedEvent binding crash)
  if (client) {
    try { await client.destroy(); } catch (_) {}
  }
  client = createClient();
  require('./events').attach(client);
  await client.initialize();
}

module.exports = { start, getClient: () => client, getStatus: () => status };
```

### 2. Socket.IO — WebSocket only, no polling

```js
// server.js
const io = new Server(httpServer, {
  transports: ['websocket'],  // NEVER include 'polling' — Nginx buffers it
  cors: { origin: '*' }
});
```

### 3. Socket.IO client — match server

```js
// public/app.js
const socket = io({ transports: ['websocket'] });
```

### 4. Re-send QR to newly connected browsers

```js
io.on('connection', (socket) => {
  socket.emit('status', { state: waStatus, qr: currentQR });
  // No async — send everything synchronously on connect
});
```

Store QR as a base64 data URL in memory. Regenerate via `QRCode.toDataURL()` once and cache it. Clear when authenticated.

---

## Database Schema

```sql
-- src/db/schema.sql

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id          TEXT PRIMARY KEY,
  group_name  TEXT NOT NULL,
  message     TEXT NOT NULL,
  media_path  TEXT,             -- local file path for attachments
  cron_expr   TEXT NOT NULL,    -- e.g. '0 9 * * 1' = Mon 9am
  label       TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name  TEXT NOT NULL,
  member_phone TEXT NOT NULL,
  member_name TEXT,
  date        TEXT NOT NULL,    -- YYYY-MM-DD
  status      TEXT NOT NULL,    -- 'present' | 'absent' | 'late'
  code        TEXT,             -- raw code received, e.g. 'P', 'L', 'A'
  source      TEXT DEFAULT 'auto',  -- 'auto' | 'manual'
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(group_name, member_phone, date)
);

CREATE TABLE IF NOT EXISTS message_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name  TEXT,
  direction   TEXT NOT NULL,    -- 'in' | 'out'
  sender      TEXT,
  body        TEXT,
  media_type  TEXT,
  timestamp   INTEGER NOT NULL  -- unix seconds
);
```

---

## Google Sheets Integration

```js
// src/services/sheets.js
// Sheet format expected:
// Column A: Group Name (must match WhatsApp group name exactly)
// Column B: Member Name
// Column C: Phone (with country code, no +)
// Column D: Attendance Code keyword (optional, e.g. 'P')

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { groups: null, fetchedAt: 0 };

async function getGroups() {
  if (Date.now() - cache.fetchedAt < CACHE_TTL) return cache.groups;
  // ... fetch from Sheets API
  cache = { groups: result, fetchedAt: Date.now() };
  return result;
}
```

---

## Attendance Flow

```
Member sends message to WhatsApp group
          ↓
client.on('message') fires
          ↓
Parse message body for attendance code (configurable per group)
          ↓
If code matches → INSERT into attendance table (source='auto')
          ↓
Emit 'attendance:update' via Socket.IO → UI updates live
          ↓
Manual override always wins (source='manual' takes priority on UPSERT)
```

Attendance codes are configured in the UI per group (e.g. group "Sales" accepts "P"=present, "L"=late, "A"=absent).

---

## API Endpoints

```
GET  /api/status              → WhatsApp connection state + QR image
GET  /api/groups              → List groups from Google Sheets (cached)
POST /api/send                → { groupName, message, mediaPath? }
POST /api/forward             → { groupName, messageId, caption? }

GET  /api/schedules           → List all schedules
POST /api/schedules           → Create schedule
PUT  /api/schedules/:id       → Update schedule
DELETE /api/schedules/:id     → Delete schedule

GET  /api/attendance?group=&date=   → Attendance for group/date
POST /api/attendance/manual         → { group, phone, date, status }
GET  /api/attendance/export?group=&from=&to=  → CSV download

GET  /api/messages?group=&from=&to= → Message log with pagination
```

---

## Socket.IO Events

```
Server → Client:
  'status'          { state: 'qr'|'ready'|'disconnected', qr?: string }
  'message:in'      { group, sender, body, timestamp }
  'attendance:new'  { group, phone, name, date, status, code }
  'schedule:fired'  { scheduleId, group }

Client → Server:
  'session:clear'   → triggers fresh QR
```

---

## Frontend Structure

Single-page app with tab navigation. No heavy framework — plain JS with Socket.IO.

```
Tabs:
  1. Connect      → QR code / connection status
  2. Groups       → List groups, select active group
  3. Send         → Compose + send / forward with optional attachment
  4. Schedule     → Create/manage scheduled messages
  5. Messages     → Scrollable chat view per group
  6. Attendance   → Table view, manual mark, export CSV
```

---

## Hostinger VPS Setup

### 1. Install dependencies

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx
npm install -g pm2
```

### 2. Install Chromium for Puppeteer

```bash
apt install -y chromium-browser
```

Set in `.env`:
```
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### 3. Nginx config (`/etc/nginx/sites-available/wa-manager`)

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket upgrade (required for Socket.IO)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering — critical for Socket.IO WebSocket
        proxy_buffering off;
        proxy_cache off;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Static files — short cache, allow revalidation
    location ~* \.(js|css|png|jpg|ico)$ {
        proxy_pass http://127.0.0.1:3000;
        expires 1h;
        add_header Cache-Control "public, must-revalidate";
        # No 'immutable' — allows browser to revalidate when file changes
    }
}
```

### 4. PM2 config (`ecosystem.config.js`)

```js
module.exports = {
  apps: [{
    name: 'wa-manager',
    script: 'server.js',
    node_args: '--max-old-space-size=512',
    instances: 1,
    exec_mode: 'fork',          // NOT cluster — cluster breaks Socket.IO without Redis
    max_memory_restart: '700M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file: './logs/err.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    cron_restart: '0 4 * * *'   // Daily 4am restart to free memory
  }]
};
```

> **Important:** Use `exec_mode: 'fork'`, not `cluster`. Cluster mode requires a Socket.IO Redis adapter for events to reach all clients. With fork mode + 1 instance, it just works.

### 5. `.env` template

```
PORT=3000
NODE_ENV=production

GOOGLE_SERVICE_ACCOUNT_EMAIL=your@service-account.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=your_sheet_id

PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ADMIN_SECRET=change_this_to_something_random
```

---

## Known Issues Solved in This Design

| Old bug | Fix applied |
|---|---|
| `onQRChangedEvent already exists` crash | Always destroy + create new Client instance, never re-initialize |
| QR events not reaching browser | Server-side `transports: ['websocket']` — no polling ever |
| Static files cached forever | `must-revalidate` not `immutable` in Nginx; bump `?v=N` in HTML on deploy |
| Memory restarts every few hours | `exec_mode: fork`, daily cron restart, 512 MB heap is sufficient |
| `isInitializing` flag race | Single initialization path, no concurrent `initialize()` calls |
| Nginx polling buffering | `proxy_buffering off` in Nginx config |
