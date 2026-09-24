import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const config = loadConfig();
const app = createApp(config);
const server = createServer(app, config);

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http';
  console.log(`scavenger-hunt-web-app listening on ${scheme}://${config.host}:${config.port}`);
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
