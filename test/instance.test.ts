import { Permission } from '@jolt/protocol';
import { JoltApiError, scoped, sortedTextChannels, type JoltSession } from '@jolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

let a: TestInstance;
let alice: JoltSession;
let bob: JoltSession;
let guildKey: string;
let channelKey: string;

beforeAll(async () => {
  a = await startInstance();
  alice = await signUp(a, 'alice');
  bob = await signUp(a, 'bob');
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut()]);
  await a?.close();
});

describe('accounts', () => {
  it('rejects a wrong password without revealing whether the handle exists', async () => {
    const rest = alice.client.probe(a.domain);
    const wrong = await rest
      .login({ handle: 'alice', password: 'nope-nope-nope' })
      .catch((e: JoltApiError) => e);
    const missing = await rest
      .login({ handle: 'nobody', password: 'nope-nope-nope' })
      .catch((e: JoltApiError) => e);
    expect(wrong).toBeInstanceOf(JoltApiError);
    expect((wrong as JoltApiError).code).toBe('invalid_credentials');
    expect((missing as JoltApiError).message).toBe((wrong as JoltApiError).message);
  });

  it('refuses duplicate handles', async () => {
    const error = await alice.client
      .probe(a.domain)
      .register({ handle: 'alice', password: 'correct horse battery' })
      .catch((e: JoltApiError) => e);
    expect((error as JoltApiError).status).toBe(409);
  });
});

describe('guilds and messages', () => {
  it('creates a guild with a default channel and delivers it over the gateway', async () => {
    guildKey = await alice.createGuild('Test Club');
    const guild = await waitFor(() => alice.state.guilds[guildKey]);
    const general = sortedTextChannels(guild.channels)[0]!;
    expect(general.name).toBe('general');
    channelKey = scoped(a.domain, general.id);
  });

  it('lets someone join with an invite and see the guild', async () => {
    const invite = await alice.rest(a.domain).createInvite(channelKey.split('|')[1]!);
    await bob.joinInvite({ instance: a.domain, code: invite.code });
    await waitFor(() => bob.state.guilds[guildKey]);
    await waitFor(() => alice.state.guilds[guildKey]?.members[bob.state.me[a.domain]!.id]);
  });

  it('delivers, edits and deletes messages in real time', async () => {
    await bob.loadMessages(channelKey);
    await alice.loadMessages(channelKey);
    await alice.sendMessage(channelKey, `hi <@${bob.state.me[a.domain]!.id}>`);

    const received = await waitFor(() =>
      bob.channelMessages(channelKey).messages.find((m) => m.content.startsWith('hi')),
    );
    expect(received.mentionIds).toEqual([bob.state.me[a.domain]!.id]);
    await waitFor(() => bob.state.readStates[channelKey]?.mentionCount === 1);

    await alice.editMessage(channelKey, received.id, 'hello there');
    await waitFor(() =>
      bob.channelMessages(channelKey).messages.find((m) => m.id === received.id && m.editedAt),
    );

    await alice.deleteMessage(channelKey, received.id);
    await waitFor(() => !bob.channelMessages(channelKey).messages.some((m) => m.id === received.id));
  });

  it('reconciles optimistic sends without duplicates', async () => {
    await bob.sendMessage(channelKey, 'one copy only');
    await waitFor(() => !bob.channelMessages(channelKey).messages.some((m) => m.pending));
    expect(
      bob.channelMessages(channelKey).messages.filter((m) => m.content === 'one copy only'),
    ).toHaveLength(1);
  });

  it('stops members from editing other people’s messages or managing channels', async () => {
    const message = bob.channelMessages(channelKey).messages.find((m) => m.content === 'one copy only')!;
    const editError = await alice
      .editMessage(channelKey, message.id, 'hijacked')
      .catch((e: JoltApiError) => e);
    expect((editError as JoltApiError).status).toBe(403);

    const channelError = await bob
      .rest(a.domain)
      .createChannel(guildKey.split('|')[1]!, { name: 'sneaky' })
      .catch((e: JoltApiError) => e);
    expect((channelError as JoltApiError).status).toBe(403);
  });

  it('hides private channels and their messages from members without access', async () => {
    const guildId = guildKey.split('|')[1]!;
    const secret = await alice.rest(a.domain).createChannel(guildId, { name: 'staff' });
    await alice.rest(a.domain).updateChannel(secret.id, {
      overwrites: [{ id: guildId, type: 'role', allow: '0', deny: Permission.VIEW_CHANNEL.toString() }],
    });

    await waitFor(() => alice.state.guilds[guildKey]?.channels[secret.id]);
    await waitFor(() => !bob.state.guilds[guildKey]?.channels[secret.id]);

    await alice.rest(a.domain).sendMessage(secret.id, { content: 'staff only' });
    const read = await bob
      .rest(a.domain)
      .messages(secret.id)
      .catch((e: JoltApiError) => e);
    expect((read as JoltApiError).status).toBe(404);
  });
});
