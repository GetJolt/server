import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import type { Dialect } from './db/connect.js';
import type { Database } from './db/schema.js';
import type { EventBus } from './events/EventBus.js';
import type { FederationState } from './services/federation.js';
import type { PermissionCache } from './services/permissions.js';
import type { PresenceTracker } from './services/presence.js';
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
  log: FastifyBaseLogger;
}
