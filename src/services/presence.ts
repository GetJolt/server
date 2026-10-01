import type { PresenceStatus } from '@jolt/protocol';

type Listener = (userId: string, status: PresenceStatus) => void;

/** In-memory presence for users connected to this instance's gateway. */
export class PresenceTracker {
  private readonly connections = new Map<string, number>();
  private readonly chosen = new Map<string, PresenceStatus>();
  private listener: Listener = () => {};

  onChange(listener: Listener): void {
    this.listener = listener;
  }

  get(userId: string): PresenceStatus {
    if (!this.connections.get(userId)) return 'offline';
    return this.chosen.get(userId) ?? 'online';
  }

  connect(userId: string): void {
    const count = this.connections.get(userId) ?? 0;
    this.connections.set(userId, count + 1);
    if (count === 0) this.listener(userId, this.get(userId));
  }

  disconnect(userId: string): void {
    const count = (this.connections.get(userId) ?? 1) - 1;
    if (count > 0) {
      this.connections.set(userId, count);
      return;
    }
    this.connections.delete(userId);
    this.listener(userId, 'offline');
  }

  setStatus(userId: string, status: PresenceStatus): void {
    const before = this.get(userId);
    // "offline" while connected means invisible: others see offline, the user stays connected.
    this.chosen.set(userId, status);
    if (this.get(userId) !== before) this.listener(userId, this.get(userId));
  }
}
