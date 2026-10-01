// Messages are the one table expected to outgrow a relational database, so nothing else touches it
// directly. A ScyllaDB/Cassandra store can implement this interface without changes elsewhere.

import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { flag, id, num, optId, optNum } from '../db/values.js';

export interface StoredMessage {
  id: string;
  channelId: string;
  guildId: string;
  authorId: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  replyToId: string | null;
  mentionIds: string[];
  mentionEveryone: boolean;
}

export interface ListOptions {
  before?: string;
  after?: string;
  around?: string;
  limit: number;
}

export interface MessageStore {
  insert(message: StoredMessage): Promise<void>;
  get(channelId: string, messageId: string): Promise<StoredMessage | null>;
  getMany(channelId: string, messageIds: string[]): Promise<StoredMessage[]>;
  /** Returns messages oldest-first. */
  list(channelId: string, options: ListOptions): Promise<StoredMessage[]>;
  edit(
    channelId: string,
    messageId: string,
    content: string,
    mentionIds: string[],
    editedAt: number,
  ): Promise<void>;
  delete(channelId: string, messageId: string): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
}

export class SqlMessageStore implements MessageStore {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(m: StoredMessage): Promise<void> {
    await this.db
      .insertInto('messages')
      .values({
        id: m.id,
        channel_id: m.channelId,
        guild_id: m.guildId,
        author_id: m.authorId,
        content: m.content,
        created_at: m.createdAt,
        edited_at: m.editedAt,
        reply_to_id: m.replyToId,
        mention_ids: JSON.stringify(m.mentionIds),
        mention_everyone: m.mentionEveryone ? 1 : 0,
      })
      .execute();
  }

  async get(channelId: string, messageId: string): Promise<StoredMessage | null> {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('id', '=', messageId)
      .executeTakeFirst();
    return row ? fromRow(row) : null;
  }

  async getMany(channelId: string, messageIds: string[]): Promise<StoredMessage[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('id', 'in', messageIds)
      .execute();
    return rows.map(fromRow);
  }

  async list(channelId: string, { before, after, around, limit }: ListOptions): Promise<StoredMessage[]> {
    if (around) {
      const half = Math.floor(limit / 2);
      const [older, newer] = await Promise.all([
        this.list(channelId, { before: around, limit: half }),
        this.list(channelId, { after: String(BigInt(around) - 1n), limit: limit - half }),
      ]);
      return [...older, ...newer];
    }

    let query = this.db.selectFrom('messages').selectAll().where('channel_id', '=', channelId);
    if (before) query = query.where('id', '<', before);
    if (after) query = query.where('id', '>', after);

    // Without `after` we want the newest page, so read descending and flip.
    const ascending = Boolean(after) && !before;
    const rows = await query
      .orderBy('id', ascending ? 'asc' : 'desc')
      .limit(limit)
      .execute();
    const messages = rows.map(fromRow);
    return ascending ? messages : messages.reverse();
  }

  async edit(channelId: string, messageId: string, content: string, mentionIds: string[], editedAt: number) {
    await this.db
      .updateTable('messages')
      .set({ content, mention_ids: JSON.stringify(mentionIds), edited_at: editedAt })
      .where('channel_id', '=', channelId)
      .where('id', '=', messageId)
      .execute();
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    await this.db
      .deleteFrom('messages')
      .where('channel_id', '=', channelId)
      .where('id', '=', messageId)
      .execute();
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.db.deleteFrom('messages').where('channel_id', '=', channelId).execute();
  }
}

function fromRow(row: {
  id: string | bigint;
  channel_id: string | bigint;
  guild_id: string | bigint;
  author_id: string | bigint;
  content: string;
  created_at: number | bigint | string;
  edited_at: number | bigint | string | null;
  reply_to_id: string | bigint | null;
  mention_ids: string;
  mention_everyone: number | bigint;
}): StoredMessage {
  return {
    id: id(row.id),
    channelId: id(row.channel_id),
    guildId: id(row.guild_id),
    authorId: id(row.author_id),
    content: row.content,
    createdAt: num(row.created_at),
    editedAt: optNum(row.edited_at),
    replyToId: optId(row.reply_to_id),
    mentionIds: JSON.parse(row.mention_ids) as string[],
    mentionEveryone: flag(row.mention_everyone),
  };
}
