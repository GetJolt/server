// Every local account (and the instance itself) signs its ActivityPub traffic. Mastodon still needs RSA HTTP
// signatures, and newer servers check Ed25519 object proofs, so each actor gets one of each, made on first use.

import { exportJwk, generateCryptoKeyPair, importJwk } from '@fedify/fedify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

type KeyPair = Awaited<ReturnType<typeof generateCryptoKeyPair>>;

const cache = new WeakMap<Kysely<Database>, Map<string, Promise<KeyPair[]>>>();

async function loadOrCreate(db: Kysely<Database>, actor: string): Promise<KeyPair[]> {
  let row = await db.selectFrom('actor_keys').selectAll().where('actor', '=', actor).executeTakeFirst();
  if (!row) {
    const [rsa, ed] = await Promise.all([
      generateCryptoKeyPair('RSASSA-PKCS1-v1_5'),
      generateCryptoKeyPair('Ed25519'),
    ]);
    const values = {
      actor,
      rsa_private: JSON.stringify(await exportJwk(rsa.privateKey)),
      rsa_public: JSON.stringify(await exportJwk(rsa.publicKey)),
      ed_private: JSON.stringify(await exportJwk(ed.privateKey)),
      ed_public: JSON.stringify(await exportJwk(ed.publicKey)),
      created_at: Date.now(),
    };
    // Two requests can race to create keys; whichever lands first wins and the other reads it back.
    await db
      .insertInto('actor_keys')
      .values(values)
      .onConflict((oc) => oc.column('actor').doNothing())
      .execute();
    row = await db.selectFrom('actor_keys').selectAll().where('actor', '=', actor).executeTakeFirstOrThrow();
  }
  const pair = async (priv: string, pub: string): Promise<KeyPair> => ({
    privateKey: await importJwk(JSON.parse(priv), 'private'),
    publicKey: await importJwk(JSON.parse(pub), 'public'),
  });
  return Promise.all([pair(row.rsa_private, row.rsa_public), pair(row.ed_private, row.ed_public)]);
}

/** RSA first (used for HTTP signatures), then Ed25519. Cached per database for the life of the process. */
export function actorKeyPairs(db: Kysely<Database>, actor: string): Promise<KeyPair[]> {
  let byActor = cache.get(db);
  if (!byActor) cache.set(db, (byActor = new Map()));
  let keys = byActor.get(actor);
  if (!keys) {
    keys = loadOrCreate(db, actor);
    keys.catch(() => byActor.delete(actor));
    byActor.set(actor, keys);
  }
  return keys;
}
