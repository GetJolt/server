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
  /** ActivityPub actor id, inbox and links for remote accounts reached over ActivityPub. */
  ap_id: string | null;
  ap_inbox: string | null;
  ap_shared_inbox: string | null;
  ap_url: string | null;
  ap_followers: string | null;
}

/** Uploaded images (avatars and post media), stored once per distinct file and named by its hash. */
export interface MediaTable {
  hash: string;
  content_type: string;
  data: Uint8Array;
  width: Int;
  height: Int;
  created_at: Int;
}

/** An image someone uploaded for a post they haven't published yet. Only its owner can attach it. */
export interface MediaUploadsTable {
  id: Id;
  user_id: Id;
  hash: string;
  created_at: Int;
}

export interface PostsTable {
  id: Id;
  author_id: Id;
  text: string;
  facets: string;
  visibility: 'public' | 'unlisted' | 'followers';
  cw: string | null;
  reply_to_id: Id | null;
  root_id: Id | null;
  quote_id: Id | null;
  reply_count: Int;
  repost_count: Int;
  like_count: Int;
  created_at: Int;
  edited_at: Int | null;
  /** The ActivityPub object id and web address of a post that came from another server. */
  ap_id: string | null;
  ap_url: string | null;
}

export interface PostMediaTable {
  post_id: Id;
  position: Int;
  media_hash: string | null;
  remote_url: string | null;
  media_type: string;
  alt: string;
  width: Int | null;
  height: Int | null;
}

export interface FollowsTable {
  follower_id: Id;
  followee_id: Id;
  state: 'pending' | 'following';
  created_at: Int;
}

export interface LikesTable {
  user_id: Id;
  post_id: Id;
  created_at: Int;
}

export interface RepostsTable {
  id: Id;
  user_id: Id;
  post_id: Id;
  created_at: Int;
}

/** Signing keys for an ActivityPub actor (a local user, or the instance itself), as JWK JSON. */
export interface ActorKeysTable {
  actor: string;
  rsa_private: string;
  rsa_public: string;
  ed_private: string;
  ed_public: string;
  created_at: Int;
}

export interface FedifyKvTable {
  key: string;
  value: string;
  expires_at: Int | null;
}

export interface FedifyQueueTable {
  id: string;
  message: string;
  deliver_at: Int;
  created_at: Int;
}

/** A Bluesky or Mastodon account someone has linked. Tokens are sealed with the instance's secret key. */
export interface LinkedAccountsTable {
  id: Id;
  user_id: Id;
  provider: 'bluesky' | 'mastodon';
  external_id: string;
  handle: string;
  url: string;
  secret: string | null;
  crosspost_default: Flag;
  show_timeline: Flag;
  verified_at: Int | null;
  created_at: Int;
}

/** A sign-in someone started with Bluesky or Mastodon, waiting for them to come back from that site. */
export interface OAuthFlowsTable {
  state: string;
  user_id: Id;
  provider: 'bluesky' | 'mastodon';
  data: string;
  expires_at: Int;
}

/** Small sealed values: Bluesky OAuth sessions and state, cached Mastodon app registrations, signing keys. */
export interface OAuthKvTable {
  key: string;
  value: string;
  expires_at: Int | null;
}

/** Where a Jolt post was cross-posted to, so replies can thread and deletes can follow it. */
export interface CrosspostsTable {
  post_id: Id;
  link_id: Id;
  /** The other network's id for the copy: a Bluesky `{ uri, cid }` or a Mastodon status id, as JSON. */
  external_ref: string;
  external_url: string;
  created_at: Int;
}

/** Background work that isn't ActivityPub delivery: cross-posting and cleaning up after it. */
export interface JobsTable {
  id: string;
  message: string;
  deliver_at: Int;
  created_at: Int;
}

export interface NotificationsTable {
  id: Id;
  user_id: Id;
  type: 'follow' | 'like' | 'repost' | 'reply' | 'mention' | 'quote';
  actor_id: Id;
  post_id: Id | null;
  read: Flag;
  created_at: Int;
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
  media: MediaTable;
  media_uploads: MediaUploadsTable;
  posts: PostsTable;
  post_media: PostMediaTable;
  follows: FollowsTable;
  likes: LikesTable;
  reposts: RepostsTable;
  notifications: NotificationsTable;
  actor_keys: ActorKeysTable;
  fedify_kv: FedifyKvTable;
  fedify_queue: FedifyQueueTable;
  linked_accounts: LinkedAccountsTable;
  oauth_flows: OAuthFlowsTable;
  oauth_kv: OAuthKvTable;
  crossposts: CrosspostsTable;
  jobs: JobsTable;
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
export type PostRow = Selectable<PostsTable>;
export type NotificationRow = Selectable<NotificationsTable>;
export type LinkedAccountRow = Selectable<LinkedAccountsTable>;
export type NewMessage = Insertable<MessagesTable>;
export type OverwriteRow = Selectable<OverwritesTable>;
