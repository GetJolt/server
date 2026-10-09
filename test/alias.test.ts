import { JoltSession, unscope } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStorage, startInstance, waitFor, type TestInstance } from './helpers.js';

let instance: TestInstance;
let alias: string;
const sessions: JoltSession[] = [];

beforeAll(async () => {
  instance = await startInstance();
  // The instance is configured as localhost:<port>, so 127.0.0.1:<port> reaches it under another name.
  alias = instance.domain.replace('localhost', '127.0.0.1');
});

afterAll(async () => {
  await Promise.all(sessions.map((s) => s.signOut()));
  await instance?.close();
});

describe('signing in through another name for the instance', () => {
  it('uses the instance’s own name as home, so its servers never need federating into', async () => {
    const storage = memoryStorage();
    const dana = new JoltSession({ storage, deviceName: 'test' });
    sessions.push(dana);
    const errors: unknown[] = [];
    dana.client.on('error', (e) => errors.push(e));

    await dana.register(alias, { handle: 'dana', password: 'correct horse battery' });
    expect(dana.client.homeDomain).toBe(instance.domain);
    expect(await storage.get('jolt.session')).toBe(instance.domain);

    const key = await dana.createGuild('Home base');
    expect(unscope(key).instance).toBe(instance.domain);

    // Starting again from storage connects straight to the guild without a federated sign-in.
    const again = new JoltSession({ storage, deviceName: 'test' });
    sessions.push(again);
    again.client.on('error', (e) => errors.push(e));
    expect(await again.restore()).toBe(true);
    await waitFor(() => again.state.guilds[key]);
    expect(errors).toEqual([]);
  });

  it('moves a session saved under the alias over to the real name', async () => {
    const first = new JoltSession({ storage: memoryStorage(), deviceName: 'test' });
    sessions.push(first);
    await first.register(instance.domain, { handle: 'erin', password: 'correct horse battery' });
    const token = first.client.home.token!;

    // What an older client would have saved after signing in through the alias.
    const storage = memoryStorage();
    await storage.set('jolt.session', alias);
    await storage.set(`jolt.token.${alias}`, token);

    const restored = new JoltSession({ storage, deviceName: 'test' });
    sessions.push(restored);
    expect(await restored.restore()).toBe(true);
    expect(restored.client.homeDomain).toBe(instance.domain);
    expect(await storage.get('jolt.session')).toBe(instance.domain);
    expect(await storage.get(`jolt.token.${instance.domain}`)).toBe(token);
    expect(await storage.get(`jolt.token.${alias}`)).toBeNull();
  });
});
