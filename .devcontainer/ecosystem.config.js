/**
 * PM2: gateway.js + bot_github.js satu paket.
 * postStartCommand dijalankan dari root repo Codespace.
 */
module.exports = {
  apps: [
    {
      name: 'gateway-otomatis',
      script: 'gateway.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':99',
        HEADLESS: 'true',
      },
    },
    {
      name: 'bot-github',
      script: 'bot_github.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 8000,
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':99',
        HEADLESS: 'true',
      },
    },
  ],
};
