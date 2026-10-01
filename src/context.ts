import type { FastifyBaseLogger } from 'fastify';
import type { ActivityPub } from './activitypub/federation.js';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import type { Dialect } from './db/connect.js';
import type { Database } from './db/schema.js';
import type { EventBus } from './events/EventBus.js';
import type { FederationState } from './services/federation.js';
import type { PermissionCache } from './services/permissions.js';
import type { PresenceTracker } from './services/presence.js';
import type { SecretBox } from './links/secrets.js';
import type { SocialHooks } from './social/hooks.js';
import type { MessageStore } from './stores/MessageStore.js';

export interface AppContext {
  config: Config;
  db: Kysely<Database>;
  dialect: Dialect;
  messages: MessageStore;
  bus: EventBus;
  perms: PermissionCache;
  presence: PresenceTracker;
  federation: FederationState;
  nextId: () => string;
  /** Filled in by the ActivityPub and linked-account layers; the social core calls them after it acts. */
  hooks: SocialHooks;
  /** Null when federation is disabled. */
  ap: ActivityPub | null;
  /** Seals linked-account tokens at rest. */
  secrets: SecretBox;
  log: FastifyBaseLogger;
}
