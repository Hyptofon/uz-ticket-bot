module.exports = {
  apps: [
    {
      name: 'uz-ticket-watcher',
      script: 'npm',
      args: 'start',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      error_file: './data/logs/err.log',
      out_file: './data/logs/out.log',
      merge_logs: true,
    },
  ],
};
