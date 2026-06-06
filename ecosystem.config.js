module.exports = {
  apps: [{
    name: 'wa-manager',
    script: 'server.js',
    node_args: '--max-old-space-size=512',
    instances: 1,
    exec_mode: 'fork',          // NOT cluster — cluster breaks Socket.IO without Redis adapter
    autorestart: true,
    watch: false,
    max_memory_restart: '700M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOME: '/home/wa-forwarder'  // Prevents Puppeteer config search from hitting /root
    },
    error_file: './logs/err.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    restart_delay: 5000,
    kill_timeout: 15000,
    cron_restart: '0 4 * * *'   // Daily 4am restart to free memory
  }]
};
