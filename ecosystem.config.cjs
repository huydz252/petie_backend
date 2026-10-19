module.exports = {
  apps: [{
    name: 'petie-backend',
    cwd: __dirname,
    script: 'dist/server.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '350M',
    restart_delay: 3000,
    time: true,
  }],
};

