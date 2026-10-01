#!/usr/bin/env node
import { buildServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await buildServer(config, {
  logger:
    process.env.NODE_ENV === 'production'
      ? { level: config.logLevel }
      : { level: config.logLevel, transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `Jolt instance "${config.name}" serving ${config.domain} (registration: ${config.registration}, federation: ${config.federation})`,
);
if (config.devInsecure)
  app.log.warn('JOLT_DEV_INSECURE is on: federation uses plain http. Never run like this in production.');
