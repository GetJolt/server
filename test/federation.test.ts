import {
  federationChallengeMessage,
  generateKeyPair,
  issueIdentityCert,
  newCertSerial,
  signBytes,
} from '@jolt/protocol';
import { scoped, sortedTextChannels, type JoltApiError, type JoltSession } from '@jolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

let a: TestInstance;
let b: TestInstance;
let alice: JoltSession;
let bob: JoltSession;

beforeAll(async () => {
  [a, b] = await Promise.all([startInstance({ name: 'A' }), startInstance({ name: 'B' })]);
  alice = await signUp(a, 'alice');
  bob = await signUp(b, 'bob');
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut()]);
  await Promise.all([a?.close(), b?.close()]);
});

async function forge(target: TestInstance, mutate: (payload: Record<string, unknown>) => void) {
  const rogueInstanceKey = await generateKeyPair();
  const device = await generateKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `mallory@${a.domain}`,
    uid: '1',
    instance: a.domain,
    kid: 'k-forged',
    devicePublicKey: device.publicKey,
    iat: now,
    exp: now + 3600,
    serial: newCertSerial(),
  };
  mutate(payload);
  const cert = await issueIdentityCert(payload as never, rogueInstanceKey.secretKey);
  const rest = alice.client.probe(target.domain);
  const { nonce } = await rest.federationChallenge();
  const signature = await signBytes(federationChallengeMessage(target.domain, nonce), device.secretKey);
  return rest.federatedAuth({ cert, nonce, signature }).catch((e: JoltApiError) => e);
}

describe('federation', () => {
  it('lets a user from another instance join a guild and chat both ways', async () => {
    const guildKey = await alice.createGuild('Cross-instance');
    const guild = await waitFor(() => alice.state.guilds[guildKey]);
    const channel = sortedTextChannels(guild.channels)[0]!;
    const channelKey = scoped(a.domain, channel.id);
    const invite = await alice.rest(a.domain).createInvite(channel.id);

    const joined = await bob.joinInvite({ instance: a.domain, code: invite.code });
    expect(joined).toBe(guildKey);
    const bobOnA = await waitFor(() => bob.state.me[a.domain]);
    expect(bobOnA.handle).toBe('bob');
    expect(bobOnA.instance).toBe(b.domain);
    expect(bobOnA.local).toBe(false);

    await Promise.all([alice.loadMessages(channelKey), bob.loadMessages(channelKey)]);
    await bob.sendMessage(channelKey, 'hello from B');
    await waitFor(() => alice.channelMessages(channelKey).messages.find((m) => m.content === 'hello from B'));
    await alice.sendMessage(channelKey, 'welcome!');
    await waitFor(() => bob.channelMessages(channelKey).messages.find((m) => m.content === 'welcome!'));

    // The guild is remembered on Bob's home instance so his other devices see it too.
    const index = await bob.client.home.rest.guildIndex();
    expect(index).toContainEqual(
      expect.objectContaining({ instance: a.domain, guildId: guildKey.split('|')[1] }),
    );
  });

  it('propagates profile changes to other instances on request', async () => {
    await bob.updateProfile({ displayName: 'Bobby' });
    const guild = Object.values(alice.state.guilds).find((g) => g.guild.name === 'Cross-instance')!;
    const bobId = Object.values(guild.members).find((m) => m.user.handle === 'bob')!.user.id;
    await waitFor(() => alice.state.guilds[guild.key]?.members[bobId]?.user.displayName === 'Bobby');
  });

  it('rejects certificates not signed by the claimed home instance', async () => {
    const error = await forge(b, () => {});
    expect((error as JoltApiError).code).toBe('invalid_cert');
  });

  it('rejects certificates claiming to come from the instance being signed in to', async () => {
    const error = await forge(a, () => {});
    expect((error as JoltApiError).status).toBe(403);
  });

  it('rejects replayed challenge signatures', async () => {
    const rest = alice.client.probe(b.domain);
    const device = await generateKeyPair();
    const { nonce } = await rest.federationChallenge();
    const cert = (await alice.client.home.rest.issueCert(device.publicKey)).cert;
    const signature = await signBytes(federationChallengeMessage(b.domain, nonce), device.secretKey);
    await rest.federatedAuth({ cert, nonce, signature });
    const replay = await rest.federatedAuth({ cert, nonce, signature }).catch((e: JoltApiError) => e);
    expect((replay as JoltApiError).code).toBe('invalid_cert');
  });

  it('refuses users from blocked instances', async () => {
    const c = await startInstance({ federationBlock: [b.domain] });
    try {
      const error = await bob.client.connect(c.domain).catch((e: JoltApiError) => e);
      expect((error as JoltApiError).code).toBe('federation_denied');
    } finally {
      await c.close();
    }
  });
});
