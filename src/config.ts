export interface Config {
  port: number;
  host: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${String(env.PORT)}`);
  }

  return {
    port,
    host: env.HOST ?? DEFAULT_HOST,
  };
}
