module.exports = {
  apps: [
    {
      name: 'wa-manager',
      script: 'server.js',
      node_args: '--max-old-space-size=512',
      instances: 1,
      exec_mode: 'fork',          // NOT cluster — cluster breaks Socket.IO without Redis adapter
      autorestart: true,
      watch: false,
      max_memory_restart: '1500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOME: '/home/wa-forwarder'  // Prevents Puppeteer config search from hitting /root
      },
      error_file: './logs/err.log',
      out_file:   './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000,
      kill_timeout: 15000,
      // cron_restart: '0 4 * * *' — disabled 2026-09-14. The nightly restart kept
      // costing the WhatsApp pairing: the session did not survive it, leaving the
      // app sitting on a QR prompt until someone rescanned (most recently for the
      // 2.5 h after the 04:00 UTC restart on 14 Sep). max_memory_restart above
      // already handles the memory growth this was meant to pre-empt.
    },
    {
      name: 'wa-watchdog',
      script: 'watchdog.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/watchdog-err.log',
      out_file:   './logs/watchdog-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000
    }
  ]
};
