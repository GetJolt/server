// Table types shared by the SQLite and Postgres backends. Integer columns come back as bigint from SQLite
// and as string from Postgres, so rows are always read through the helpers in ./values.ts.

import type { ColumnType, Insertable, Selectable } from 'kysely';

type Id = ColumnType<string | bigint, string, string>;
type Int = ColumnType<number | bigint | string, number, number>;
type Flag = ColumnType<number | bigint, number, number>;

export interface InstanceKeysTable {
  kid: string;
  public_key: string;
  secret_key: string;
  created_at: Int;
  not_after: Int | null;
}

export interface UsersTable {
  id: Id;
  handle: string;
  instance: string;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  is_local: Flag;
  remote_id: string | null;
  created_at: Int;
  profile_fetched_at: Int | null;
}

export interface CredentialsTable {
  user_id: Id;
  password_hash: string;
}

export interface SessionsTable {
  id: string;
  token_hash: string;
  user_id: Id;
  device_name: string;
  kind: 'local' | 'federated';
  cert_serial: string | null;
  created_at: Int;
  last_used_at: Int;
  expires_at: Int | null;
  revocation_checked_at: Int | null;
}

export interface IdentityCertsTable {
  serial: string;
  user_id: Id;
  session_id: string;
  device_public_key: string;
  issued_at: Int;
  expires_at: Int;
  revoked: Flag;
}

export interface RemoteInstancesTable {
  domain: string;
  info: string;
  fetched_at: Int;
}

export interface GuildsTable {
  id: Id;
  name: string;
  description: string;
  icon_url: string | null;
  owner_id: Id;
  created_at: Int;
}

export interface ChannelsTable {
  id: Id;
  guild_id: Id;
  type: 'text' | 'category';
  name: string;
  topic: string;
  position: Int;
  parent_id: Id | null;
  last_message_id: Id | null;
  created_at: Int;
}

export interface OverwritesTable {
  channel_id: Id;
  target_id: Id;
  target_type: 'role' | 'member';
  allow: string;
  deny: string;
}

export interface RolesTable {
  id: Id;
  guild_id: Id;
  name: string;
  color: Int | null;
  position: Int;
  permissions: string;
  hoist: Flag;
  mentionable: Flag;
}

export interface MembersTable {
  guild_id: Id;
  user_id: Id;
  nickname: string | null;
  joined_at: Int;
}

export interface MemberRolesTable {
  guild_id: Id;
  user_id: Id;
  role_id: Id;
}

export interface InvitesTable {
  code: string;
  guild_id: Id;
  channel_id: Id;
  inviter_id: Id | null;
  uses: Int;
  max_uses: Int | null;
  expires_at: Int | null;
  created_at: Int;
}

export interface BansTable {
  guild_id: Id;
  user_id: Id;
  reason: string;
  moderator_id: Id | null;
  created_at: Int;
}

export interface MessagesTable {
  id: Id;
  channel_id: Id;
  guild_id: Id;
  author_id: Id;
  content: string;
  created_at: Int;
  edited_at: Int | null;
  reply_to_id: Id | null;
  mention_ids: string;
  mention_everyone: Flag;
}

export interface ReadStatesTable {
  user_id: Id;
  channel_id: Id;
  last_read_message_id: Id | null;
  mention_count: Int;
}

export interface GuildIndexTable {
  user_id: Id;
  instance: string;
  guild_id: string;
  position: Int;
}

export interface Database {
  instance_keys: InstanceKeysTable;
  users: UsersTable;
  credentials: CredentialsTable;
  sessions: SessionsTable;
  identity_certs: IdentityCertsTable;
  remote_instances: RemoteInstancesTable;
  guilds: GuildsTable;
  channels: ChannelsTable;
  permission_overwrites: OverwritesTable;
  roles: RolesTable;
  guild_members: MembersTable;
  member_roles: MemberRolesTable;
  invites: InvitesTable;
  bans: BansTable;
  messages: MessagesTable;
  read_states: ReadStatesTable;
  guild_index: GuildIndexTable;
}

export type UserRow = Selectable<UsersTable>;
export type GuildRow = Selectable<GuildsTable>;
export type ChannelRow = Selectable<ChannelsTable>;
export type RoleRow = Selectable<RolesTable>;
export type MessageRow = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;
export type OverwriteRow = Selectable<OverwritesTable>;
