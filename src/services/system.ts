// Messages from the instance itself to one of its users, like the welcome new accounts get. Clients show them as a
// read-only conversation with "Jolt", so there's nothing to reply to.

import type { SystemMessage, SystemMessageList } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { SystemMessageRow } from '../db/schema.js';
import { flag, id, num } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';

/** Only the latest are listed, so a long-lived account's conversation stays small. */
const LIST_LIMIT = 100;

type Row = Pick<SystemMessageRow, 'text' | 'read' | 'created_at'> & { id: string | bigint };

const serialize = (row: Row): SystemMessage => ({
  id: id(row.id),
  text: row.text,
  createdAt: num(row.created_at),
  read: flag(row.read),
});

export async function sendSystemMessage(
  ctx: AppContext,
  userId: string,
  text: string,
): Promise<SystemMessage> {
  const row = { id: ctx.nextId(), user_id: userId, text, read: 0, created_at: Date.now() };
  await ctx.db.insertInto('system_messages').values(row).execute();
  const message = serialize(row);
  ctx.bus.publish(userTopic(userId), { t: 'SYSTEM_MESSAGE_CREATE', d: message });
  return message;
}

/** Sends the configured welcome to a brand new account. Does nothing unless the instance has one set. */
export async function sendWelcome(ctx: AppContext, userId: string, name: string): Promise<void> {
  const template = ctx.config.welcomeMessage;
  if (!template) return;
  await sendSystemMessage(ctx, userId, template.replaceAll('{name}', name));
}

/** The user's system messages, oldest first like a chat. */
export async function listSystemMessages(ctx: AppContext, userId: string): Promise<SystemMessageList> {
  const rows = await ctx.db
    .selectFrom('system_messages')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('id', 'desc')
    .limit(LIST_LIMIT)
    .execute();
  const items = rows.reverse().map(serialize);
  return { items, unread: items.filter((m) => !m.read).length };
}

export async function markSystemMessagesRead(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db
    .updateTable('system_messages')
    .set({ read: 1 })
    .where('user_id', '=', userId)
    .where('read', '=', 0)
    .execute();
}
