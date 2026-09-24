import { createApp } from './app.js';
import { loadConfig } from './config.js';

const { port, host } = loadConfig();
const server = createApp().listen(port, host, () => {
  console.log(`scavenger-hunt-web-app listening on http://${host}:${port}`);
});

// Containers stop with a signal; close the listener so in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      process.exit(0);
    });
  });
}
