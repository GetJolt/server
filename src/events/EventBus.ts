// Fan-out for gateway events. Topics are `guild:<id>` and `user:<id>`. The in-process bus is enough for a
// single server; a Redis-backed implementation can slot in behind the same interface later.

import type { GatewayEventName, GatewayEvents } from '@jolt/protocol';

export type DispatchEvent = {
  [K in GatewayEventName]: {
    t: K;
    d: GatewayEvents[K];
    /** Set for channel-scoped events so the gateway can drop them for members who can't see the channel. */
    channelId?: string;
  };
}[GatewayEventName];

/** Permissions or channel visibility changed, so each session should resend its view of the guild. */
export interface ResyncEvent {
  t: 'RESYNC';
  guildId: string;
}

export type BusEvent = DispatchEvent | ResyncEvent;

export type BusHandler = (event: BusEvent) => void;

export interface EventBus {
  publish(topic: string, event: BusEvent): void;
  subscribe(topic: string, handler: BusHandler): () => void;
}

export class LocalEventBus implements EventBus {
  private readonly topics = new Map<string, Set<BusHandler>>();

  publish(topic: string, event: BusEvent): void {
    for (const handler of this.topics.get(topic) ?? []) handler(event);
  }

  subscribe(topic: string, handler: BusHandler): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) this.topics.set(topic, (handlers = new Set()));
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.topics.delete(topic);
    };
  }
}

export const guildTopic = (guildId: string) => `guild:${guildId}`;
export const userTopic = (userId: string) => `user:${userId}`;
