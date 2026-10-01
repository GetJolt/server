// Fedify needs somewhere to cache documents and keys, and a queue for deliveries. Its own SQLite and Postgres
// backends use different drivers from ours, so these keep everything in the instance's existing database.

import { randomUUID } from 'node:crypto';
import type {
  KvKey,
  KvStore,
  KvStoreListEntry,
  KvStoreSetOptions,
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from '@fedify/fedify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { num } from '../db/values.js';

const encodeKey = (key: KvKey) => JSON.stringify(key);
const millis = (duration: { total(unit: 'millisecond'): number } | undefined) =>
  duration ? duration.total('millisecond') : 0;

export class KyselyKvStore implements KvStore {
  constructor(private readonly db: Kysely<Database>) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const row = await this.db
      .selectFrom('fedify_kv')
      .select(['value', 'expires_at'])
      .where('key', '=', encodeKey(key))
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.expires_at !== null && num(row.expires_at) < Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    const ttl = millis(options?.ttl as never);
    const row = {
      key: encodeKey(key),
      value: JSON.stringify(value),
      expires_at: ttl > 0 ? Date.now() + ttl : null,
    };
    await this.db
      .insertInto('fedify_kv')
      .values(row)
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: row.value, expires_at: row.expires_at }))
      .execute();
  }

  async delete(key: KvKey): Promise<void> {
    await this.db.deleteFrom('fedify_kv').where('key', '=', encodeKey(key)).execute();
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    let query = this.db.selectFrom('fedify_kv').select(['key', 'value', 'expires_at']);
    if (prefix) {
      // ["a","b"] is a prefix of ["a","b","c"]: match the exact key or the encoding with the bracket left open.
      const exact = encodeKey(prefix);
      const open = exact.slice(0, -1) + ',';
      const pattern = `${escapeLike(open)}%`;
      query = query.where((eb) =>
        eb.or([eb('key', '=', exact), sql<boolean>`key like ${pattern} escape '!'`]),
      );
    }
    for (const row of await query.execute()) {
      if (row.expires_at !== null && num(row.expires_at) < Date.now()) continue;
      yield { key: JSON.parse(row.key) as KvKey, value: JSON.parse(row.value) };
    }
  }

  async purgeExpired(): Promise<void> {
    await this.db.deleteFrom('fedify_kv').where('expires_at', '<', Date.now()).execute();
  }
}

/** URLs in keys contain `%` and `_`, which LIKE would treat as wildcards. `!` is the escape character. */
const escapeLike = (value: string) => value.replace(/[!%_]/g, (ch) => `!${ch}`);

/**
 * A polling queue. Each message is claimed by deleting its row, so several server processes can share one
 * database without delivering anything twice. Fedify retries failed deliveries by enqueueing them again.
 */
export class KyselyMessageQueue implements MessageQueue {
  readonly nativeRetrial = false;
  private readonly wake = new Set<() => void>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly pollMs = 1000,
    /** Both queue tables have the same shape; `jobs` holds the server's own background work. */
    private readonly table: 'fedify_queue' | 'jobs' = 'fedify_queue',
  ) {}

  async enqueue(message: unknown, options?: MessageQueueEnqueueOptions): Promise<void> {
    await this.enqueueMany([message], options);
  }

  async enqueueMany(messages: readonly unknown[], options?: MessageQueueEnqueueOptions): Promise<void> {
    await this.insert(messages, millis(options?.delay as never));
  }

  /** Enqueues with a plain millisecond delay, for callers that don't speak Temporal. */
  enqueueAfter(message: unknown, delayMs: number): Promise<void> {
    return this.insert([message], delayMs);
  }

  private async insert(messages: readonly unknown[], delayMs: number): Promise<void> {
    if (messages.length === 0) return;
    const now = Date.now();
    const deliverAt = now + delayMs;
    await this.db
      .insertInto(this.table as 'fedify_queue')
      .values(
        messages.map((message) => ({
          id: randomUUID(),
          message: JSON.stringify(message),
          deliver_at: deliverAt,
          created_at: now,
        })),
      )
      .execute();
    if (deliverAt <= now) for (const wake of this.wake) wake();
  }

  async getDepth() {
    const row = await this.db
      .selectFrom(this.table as 'fedify_queue')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return { queued: num(row.n) };
  }

  async listen(handler: (message: unknown) => Promise<void> | void, options?: MessageQueueListenOptions) {
    const signal = options?.signal;
    while (!signal?.aborted) {
      const due = await this.db
        .selectFrom(this.table as 'fedify_queue')
        .select(['id', 'message'])
        .where('deliver_at', '<=', Date.now())
        .orderBy('deliver_at')
        .limit(20)
        .execute();
      for (const row of due) {
        const claimed = await this.db
          .deleteFrom(this.table as 'fedify_queue')
          .where('id', '=', row.id)
          .executeTakeFirst();
        if (Number(claimed.numDeletedRows) === 0) continue;
        try {
          await handler(JSON.parse(row.message));
        } catch {
          // Fedify reports and reschedules failures itself; one bad message mustn't stop the loop.
        }
      }
      if (due.length === 0) await this.sleep(signal);
    }
  }

  private sleep(signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      this.wake.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
