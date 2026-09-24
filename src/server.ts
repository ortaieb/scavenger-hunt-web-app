import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Express } from 'express';
import type { Config } from './config.js';

/**
 * Camera and geolocation APIs require a secure context, so any host other
 * than `localhost` needs HTTPS. Serves HTTPS when `config.tls` is set
 * (explicit cert/key paths, or the auto-detected dev cert), plain HTTP
 * otherwise — which is fine for localhost-only development.
 */
export function createServer(app: Express, config: Config): HttpServer | HttpsServer {
  if (!config.tls) {
    return createHttpServer(app);
  }

  const key = readFileSync(config.tls.keyPath);
  const cert = readFileSync(config.tls.certPath);
  return createHttpsServer({ key, cert }, app);
}
