module.exports = {
  apps: [
    {
      name: "devopsakademy-api",
      script: "src/server.ts",

      // TypeScript runtime
      interpreter: "node",
      interpreter_args: "-r ts-node/register",

      // Environnement
      env: {
        NODE_ENV: "development",
      },

      // Redémarrage & stabilité
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      // Logs
      error_file: "logs/api-error.log",
      out_file: "logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // Mémoire
      max_memory_restart: "500M",
    },
  ],
};

