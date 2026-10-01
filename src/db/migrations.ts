// Migrations are written with Kysely's schema builder using only types both SQLite and Postgres accept.

import { PostgresAdapter, type Kysely } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('instance_keys')
        .addColumn('kid', 'text', (c) => c.primaryKey())
        .addColumn('public_key', 'text', (c) => c.notNull())
        .addColumn('secret_key', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('not_after', 'bigint')
        .execute();

      await db.schema
        .createTable('users')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('handle', 'text', (c) => c.notNull())
        .addColumn('instance', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('avatar_url', 'text')
        .addColumn('bio', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('is_local', 'integer', (c) => c.notNull())
        .addColumn('remote_id', 'text')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('profile_fetched_at', 'bigint')
        .addUniqueConstraint('users_address_unique', ['handle', 'instance'])
        .execute();

      await db.schema
        .createTable('credentials')
        .addColumn('user_id', 'bigint', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
        .addColumn('password_hash', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('token_hash', 'text', (c) => c.notNull())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('device_name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('cert_serial', 'text')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('last_used_at', 'bigint', (c) => c.notNull())
        .addColumn('expires_at', 'bigint')
        .addColumn('revocation_checked_at', 'bigint')
        .execute();
      await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

      await db.schema
        .createTable('identity_certs')
        .addColumn('serial', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('session_id', 'text', (c) => c.notNull())
        .addColumn('device_public_key', 'text', (c) => c.notNull())
        .addColumn('issued_at', 'bigint', (c) => c.notNull())
        .addColumn('expires_at', 'bigint', (c) => c.notNull())
        .addColumn('revoked', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema
        .createIndex('identity_certs_session_idx')
        .on('identity_certs')
        .column('session_id')
        .execute();

      await db.schema
        .createTable('remote_instances')
        .addColumn('domain', 'text', (c) => c.primaryKey())
        .addColumn('info', 'text', (c) => c.notNull())
        .addColumn('fetched_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('guilds')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('icon_url', 'text')
        .addColumn('owner_id', 'bigint', (c) => c.notNull().references('users.id'))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('channels')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('topic', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('parent_id', 'bigint')
        .addColumn('last_message_id', 'bigint')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('channels_guild_idx').on('channels').column('guild_id').execute();

      await db.schema
        .createTable('permission_overwrites')
        .addColumn('channel_id', 'bigint', (c) => c.notNull().references('channels.id').onDelete('cascade'))
        .addColumn('target_id', 'bigint', (c) => c.notNull())
        .addColumn('target_type', 'text', (c) => c.notNull())
        .addColumn('allow', 'text', (c) => c.notNull())
        .addColumn('deny', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('permission_overwrites_pk', ['channel_id', 'target_id'])
        .execute();

      await db.schema
        .createTable('roles')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('color', 'integer')
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('permissions', 'text', (c) => c.notNull())
        .addColumn('hoist', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('mentionable', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema.createIndex('roles_guild_idx').on('roles').column('guild_id').execute();

      await db.schema
        .createTable('guild_members')
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('nickname', 'text')
        .addColumn('joined_at', 'bigint', (c) => c.notNull())
        .addPrimaryKeyConstraint('guild_members_pk', ['guild_id', 'user_id'])
        .execute();
      await db.schema.createIndex('guild_members_user_idx').on('guild_members').column('user_id').execute();

      await db.schema
        .createTable('member_roles')
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('user_id', 'bigint', (c) => c.notNull())
        .addColumn('role_id', 'bigint', (c) => c.notNull().references('roles.id').onDelete('cascade'))
        .addPrimaryKeyConstraint('member_roles_pk', ['guild_id', 'user_id', 'role_id'])
        .execute();

      await db.schema
        .createTable('invites')
        .addColumn('code', 'text', (c) => c.primaryKey())
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('channel_id', 'bigint', (c) => c.notNull().references('channels.id').onDelete('cascade'))
        .addColumn('inviter_id', 'bigint')
        .addColumn('uses', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('max_uses', 'integer')
        .addColumn('expires_at', 'bigint')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('bans')
        .addColumn('guild_id', 'bigint', (c) => c.notNull().references('guilds.id').onDelete('cascade'))
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('reason', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('moderator_id', 'bigint')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addPrimaryKeyConstraint('bans_pk', ['guild_id', 'user_id'])
        .execute();

      await db.schema
        .createTable('messages')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('channel_id', 'bigint', (c) => c.notNull().references('channels.id').onDelete('cascade'))
        .addColumn('guild_id', 'bigint', (c) => c.notNull())
        .addColumn('author_id', 'bigint', (c) => c.notNull())
        .addColumn('content', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('edited_at', 'bigint')
        .addColumn('reply_to_id', 'bigint')
        .addColumn('mention_ids', 'text', (c) => c.notNull().defaultTo('[]'))
        .addColumn('mention_everyone', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema
        .createIndex('messages_channel_id_idx')
        .on('messages')
        .columns(['channel_id', 'id'])
        .execute();

      await db.schema
        .createTable('read_states')
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('channel_id', 'bigint', (c) => c.notNull().references('channels.id').onDelete('cascade'))
        .addColumn('last_read_message_id', 'bigint')
        .addColumn('mention_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addPrimaryKeyConstraint('read_states_pk', ['user_id', 'channel_id'])
        .execute();

      await db.schema
        .createTable('guild_index')
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('instance', 'text', (c) => c.notNull())
        .addColumn('guild_id', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('guild_index_pk', ['user_id', 'instance', 'guild_id'])
        .execute();
    },
  },

  '0002_avatars': {
    async up(db: Kysely<unknown>) {
      const binary = db.getExecutor().adapter instanceof PostgresAdapter ? 'bytea' : 'blob';
      await db.schema
        .createTable('avatars')
        .addColumn('hash', 'text', (c) => c.primaryKey())
        .addColumn('content_type', 'text', (c) => c.notNull())
        .addColumn('data', binary, (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
