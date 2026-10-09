import type { JoltSession } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { sendSystemMessage } from '../src/services/system.js';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

let welcoming: TestInstance;
let quiet: TestInstance;
const sessions: JoltSession[] = [];

beforeAll(async () => {
  [welcoming, quiet] = await Promise.all([
    startInstance({ welcomeMessage: 'Hey {name}!\n\nJoin us: https://joltapp.org/invite/abc123' }),
    startInstance(),
  ]);
});

afterAll(async () => {
  await Promise.all(sessions.map((s) => s.signOut()));
  await Promise.all([welcoming?.close(), quiet?.close()]);
});

describe('system messages', () => {
  it('welcomes new accounts when the instance has a welcome set', async () => {
    const alice = await signUp(welcoming, 'alice');
    sessions.push(alice);
    await alice.social.loadSystemMessages();
    const { system } = alice.social.state;
    expect(system.items).toHaveLength(1);
    expect(system.items[0]).toMatchObject({
      text: 'Hey alice!\n\nJoin us: https://joltapp.org/invite/abc123',
      read: false,
    });
    expect(system.unread).toBe(1);

    await alice.social.markSystemMessagesRead();
    await alice.social.loadSystemMessages();
    expect(alice.social.state.system.unread).toBe(0);
    expect(alice.social.state.system.items[0]!.read).toBe(true);
  });

  it('arrives live over the gateway', async () => {
    const bob = await signUp(welcoming, 'bob');
    sessions.push(bob);
    await bob.social.loadSystemMessages();
    await sendSystemMessage(
      welcoming.ctx,
      bob.state.me[welcoming.domain]!.id,
      'Scheduled maintenance tonight.',
    );
    await waitFor(() => bob.social.state.system.items.length === 2);
    expect(bob.social.state.system.unread).toBe(2);
  });

  it('sends nothing by default', async () => {
    const carol = await signUp(quiet, 'carol');
    sessions.push(carol);
    await carol.social.loadSystemMessages();
    expect(carol.social.state.system.items).toEqual([]);
  });

  it('builds the welcome from the env vars', () => {
    expect(loadConfig({}).welcomeMessage).toBeNull();
    const standard = loadConfig({ JOLT_WELCOME_INVITE: 'https://joltapp.org/invite/abc123' }).welcomeMessage;
    expect(standard).toContain('{name}');
    expect(standard).toContain('https://joltapp.org/invite/abc123');
    expect(
      loadConfig({ JOLT_WELCOME_MESSAGE: 'Hi {name}\\n{invite}', JOLT_WELCOME_INVITE: 'x' }).welcomeMessage,
    ).toBe('Hi {name}\nx');
  });
});
