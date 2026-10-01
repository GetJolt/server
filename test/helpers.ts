import { createServer } from 'node:net';
import { JoltSession, type SecureStorage } from '@jolt/sdk';
import { buildServer, type JoltServer } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface TestInstance extends JoltServer {
  domain: string;
  close: () => Promise<void>;
}

export async function startInstance(overrides: Partial<Config> = {}): Promise<TestInstance> {
  const port = await freePort();
  const config = loadConfig(
    {},
    {
      domain: `localhost:${port}`,
      port,
      host: '127.0.0.1',
      database: ':memory:',
      devInsecure: true,
      logLevel: 'silent',
      ...overrides,
    },
  );
  const server = await buildServer(config, { logger: false });
  await server.app.listen({ host: config.host, port });
  return { ...server, domain: config.domain, close: () => server.app.close() };
}

export function memoryStorage(): SecureStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

export async function signUp(instance: TestInstance, handle: string): Promise<JoltSession> {
  const session = new JoltSession({ storage: memoryStorage(), deviceName: 'test' });
  await session.register(instance.domain, { handle, password: 'correct horse battery' });
  await waitFor(() => session.state.me[instance.domain]);
  return session;
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}
