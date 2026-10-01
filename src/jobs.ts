// Background work that shouldn't hold up a request: talking to Bluesky and Mastodon for cross-posts. Jobs live in
// the database, so a restart doesn't lose them, and failures are retried with a growing delay.

import type { Kysely } from 'kysely';
import { KyselyMessageQueue } from './activitypub/store.js';
import type { Database } from './db/schema.js';

export type Job =
  | { type: 'crosspost'; postId: string; linkId: string }
  | { type: 'crosspost-delete'; linkId: string; ref: string; provider: 'bluesky' | 'mastodon' };

type Envelope = Job & { attempt: number };
type Handler = (job: Job) => Promise<void>;

const MAX_ATTEMPTS = 6;

export class Jobs {
  private readonly queue: KyselyMessageQueue;
  private readonly stopping = new AbortController();
  private handler: Handler | null = null;
  private running: Promise<void> | null = null;

  constructor(
    db: Kysely<Database>,
    private readonly log: { warn(obj: unknown, msg: string): void },
    pollMs = 1000,
  ) {
    this.queue = new KyselyMessageQueue(db, pollMs, 'jobs');
  }

  handle(handler: Handler): void {
    this.handler = handler;
  }

  enqueue(job: Job): Promise<void> {
    return this.queue.enqueue({ ...job, attempt: 0 } satisfies Envelope);
  }

  start(): void {
    this.running ??= this.queue.listen((message) => this.run(message as Envelope), {
      signal: this.stopping.signal,
    });
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.running;
  }

  private async run(envelope: Envelope) {
    const { attempt, ...job } = envelope;
    try {
      await this.handler?.(job as Job);
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        this.log.warn({ err: error, job }, 'Giving up on a background job');
        return;
      }
      // 30s, 1m, 2m, 4m, 8m: long enough to ride out a provider having a bad few minutes.
      const delayMs = 30_000 * 2 ** attempt;
      await this.queue.enqueueAfter({ ...job, attempt: attempt + 1 }, delayMs);
    }
  }
}
