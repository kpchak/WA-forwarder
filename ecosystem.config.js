module.exports = {
  apps: [{
    name: 'wa-forwarder',
    script: 'server.js',
    node_args: '--expose-gc --max-old-space-size=768',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '900M',
    env: {
      NODE_ENV: 'production',
      HOSTINGER: 'true',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    restart_delay: 5000,
    kill_timeout: 10000,
    listen_timeout: 30000,
    exp_backoff_restart_delay: 100,
    cron_restart: '0 4 * * *'
  }]
};
