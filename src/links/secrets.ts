// Tokens for linked Bluesky and Mastodon accounts are sealed with AES-256-GCM before they touch the database, so a
// leaked backup on its own doesn't hand out access to anyone's other accounts.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';

export class SecretBox {
  constructor(private readonly key: Buffer) {}

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/**
 * The key comes from `JOLT_SECRET_KEY` if set. Otherwise one is generated and kept in `secret.key` beside the
 * SQLite file (or in ./data for Postgres), so it survives restarts and sits in the same volume as the data.
 */
export function loadSecretBox(config: Config): SecretBox {
  if (config.secretKey) return new SecretBox(createHash('sha256').update(config.secretKey).digest());
  if (config.database === ':memory:') return new SecretBox(randomBytes(32));

  const folder = /^postgres(ql)?:\/\//.test(config.database) ? './data' : dirname(config.database);
  const file = join(folder, 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
}
