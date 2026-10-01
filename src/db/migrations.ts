// Migrations are written with Kysely's schema builder using only types both SQLite and Postgres accept.

import { PostgresAdapter, sql, type Kysely } from 'kysely';
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

  '0003_social': {
    async up(db: Kysely<unknown>) {
      const binary = db.getExecutor().adapter instanceof PostgresAdapter ? 'bytea' : 'blob';
      await db.schema
        .createTable('media')
        .addColumn('hash', 'text', (c) => c.primaryKey())
        .addColumn('content_type', 'text', (c) => c.notNull())
        .addColumn('data', binary, (c) => c.notNull())
        .addColumn('width', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('height', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await sql`insert into media (hash, content_type, data, created_at)
        select hash, content_type, data, created_at from avatars`.execute(db);
      await db.schema.dropTable('avatars').execute();

      await db.schema
        .createTable('media_uploads')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('posts')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('author_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('facets', 'text', (c) => c.notNull().defaultTo('[]'))
        .addColumn('visibility', 'text', (c) => c.notNull())
        .addColumn('cw', 'text')
        .addColumn('reply_to_id', 'bigint')
        .addColumn('root_id', 'bigint')
        .addColumn('quote_id', 'bigint')
        .addColumn('reply_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('repost_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('like_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('edited_at', 'bigint')
        .execute();
      await db.schema.createIndex('posts_author_idx').on('posts').columns(['author_id', 'id']).execute();
      await db.schema.createIndex('posts_reply_idx').on('posts').columns(['reply_to_id', 'id']).execute();

      await db.schema
        .createTable('post_media')
        .addColumn('post_id', 'bigint', (c) => c.notNull().references('posts.id').onDelete('cascade'))
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('media_hash', 'text')
        .addColumn('remote_url', 'text')
        .addColumn('media_type', 'text', (c) => c.notNull())
        .addColumn('alt', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('width', 'integer')
        .addColumn('height', 'integer')
        .addPrimaryKeyConstraint('post_media_pk', ['post_id', 'position'])
        .execute();

      await db.schema
        .createTable('follows')
        .addColumn('follower_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('followee_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addPrimaryKeyConstraint('follows_pk', ['follower_id', 'followee_id'])
        .execute();
      await db.schema.createIndex('follows_followee_idx').on('follows').column('followee_id').execute();

      await db.schema
        .createTable('likes')
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('post_id', 'bigint', (c) => c.notNull().references('posts.id').onDelete('cascade'))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addPrimaryKeyConstraint('likes_pk', ['user_id', 'post_id'])
        .execute();
      await db.schema.createIndex('likes_post_idx').on('likes').column('post_id').execute();

      await db.schema
        .createTable('reposts')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('post_id', 'bigint', (c) => c.notNull().references('posts.id').onDelete('cascade'))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addUniqueConstraint('reposts_once', ['user_id', 'post_id'])
        .execute();
      await db.schema.createIndex('reposts_user_idx').on('reposts').columns(['user_id', 'id']).execute();

      await db.schema
        .createTable('notifications')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('actor_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('post_id', 'bigint', (c) => c.references('posts.id').onDelete('cascade'))
        .addColumn('read', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('notifications_user_idx')
        .on('notifications')
        .columns(['user_id', 'id'])
        .execute();
    },
  },

  '0004_activitypub': {
    async up(db: Kysely<unknown>) {
      for (const column of ['ap_id', 'ap_inbox', 'ap_shared_inbox', 'ap_url', 'ap_followers']) {
        await db.schema.alterTable('users').addColumn(column, 'text').execute();
      }
      await db.schema.createIndex('users_ap_id_unique').unique().on('users').column('ap_id').execute();

      await db.schema.alterTable('posts').addColumn('ap_id', 'text').execute();
      await db.schema.alterTable('posts').addColumn('ap_url', 'text').execute();
      await db.schema.createIndex('posts_ap_id_unique').unique().on('posts').column('ap_id').execute();

      await db.schema
        .createTable('actor_keys')
        .addColumn('actor', 'text', (c) => c.primaryKey())
        .addColumn('rsa_private', 'text', (c) => c.notNull())
        .addColumn('rsa_public', 'text', (c) => c.notNull())
        .addColumn('ed_private', 'text', (c) => c.notNull())
        .addColumn('ed_public', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('fedify_kv')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'bigint')
        .execute();

      await db.schema
        .createTable('fedify_queue')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('message', 'text', (c) => c.notNull())
        .addColumn('deliver_at', 'bigint', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('fedify_queue_due_idx').on('fedify_queue').column('deliver_at').execute();
    },
  },

  '0005_linked_accounts': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('linked_accounts')
        .addColumn('id', 'bigint', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('external_id', 'text', (c) => c.notNull())
        .addColumn('handle', 'text', (c) => c.notNull())
        .addColumn('url', 'text', (c) => c.notNull())
        .addColumn('secret', 'text')
        .addColumn('crosspost_default', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('show_timeline', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('verified_at', 'bigint')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addUniqueConstraint('linked_accounts_once', ['user_id', 'provider', 'external_id'])
        .execute();
      await db.schema
        .createIndex('linked_accounts_external_idx')
        .on('linked_accounts')
        .columns(['provider', 'external_id'])
        .execute();

      await db.schema
        .createTable('oauth_flows')
        .addColumn('state', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'bigint', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('data', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'bigint', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('oauth_kv')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'bigint')
        .execute();
    },
  },

  '0006_crossposts': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('crossposts')
        .addColumn('post_id', 'bigint', (c) => c.notNull())
        .addColumn('link_id', 'bigint', (c) =>
          c.notNull().references('linked_accounts.id').onDelete('cascade'),
        )
        .addColumn('external_ref', 'text', (c) => c.notNull())
        .addColumn('external_url', 'text', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addPrimaryKeyConstraint('crossposts_pk', ['post_id', 'link_id'])
        .execute();

      await db.schema
        .createTable('jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('message', 'text', (c) => c.notNull())
        .addColumn('deliver_at', 'bigint', (c) => c.notNull())
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('jobs_due_idx').on('jobs').column('deliver_at').execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
