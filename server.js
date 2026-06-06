'use strict';

require('dotenv').config();                              // load .env
require('dotenv').config({ path: '.env.local', override: true }); // local overrides

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const wa         = require('./src/whatsapp/client');
const scheduler  = require('./src/services/scheduler');
const attendance = require('./src/services/attendance');

// ── Express + Socket.IO ───────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  transports: ['websocket'],   // WebSocket only — polling gets buffered by Nginx
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout:  60000,
});

wa.setIO(io);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16mb' }));  // raised for base64 media payloads

// Static files — 1h cache with ETag revalidation; HTML always no-cache
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api',           require('./src/routes/whatsapp'));
app.use('/api/groups',    require('./src/routes/groups'));
app.use('/api/messages',  require('./src/routes/messages'));
app.use('/api/schedules',  require('./src/routes/schedule'));
app.use('/api/attendance', require('./src/routes/attendance'));
app.use('/api/templates',      require('./src/routes/templateStore'));
app.use('/api/chat-messages', require('./src/routes/chatMessages'));
app.use('/api/sheet-writer',  require('./src/routes/sheetWriter'));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[IO] Connected: ${socket.id}`);

  // Send current WhatsApp state synchronously on connect
  socket.emit('wa:status', { state: wa.getState(), qr: wa.getQR() });

  socket.on('session:clear', () => {
    wa.clearSession().catch((err) => console.error('[IO] clearSession error:', err.message));
  });

  socket.on('disconnect', (reason) => {
    console.log(`[IO] Disconnected: ${socket.id} (${reason})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  attendance.init();  // load attendance records and config
  scheduler.init();   // load saved schedules and start cron jobs
  wa.start();
});
