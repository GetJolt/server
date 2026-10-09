import { isValidInstance, normalizeInstance } from '@getjolt/protocol';

export interface Config {
  domain: string;
  host: string;
  port: number;
  name: string;
  description: string;
  database: string;
  registration: 'open' | 'invite' | 'closed';
  registrationCodes: string[];
  federation: 'open' | 'allowlist' | 'disabled';
  federationAllow: string[];
  federationBlock: string[];
  allowRemoteGuildCreation: boolean;
  trustProxy: boolean;
  devInsecure: boolean;
  workerId: number;
  logLevel: string;
  /** Seals linked-account tokens. From JOLT_SECRET_KEY, or a key file kept next to the database. */
  secretKey: string | null;
  /**
   * What new accounts are sent from "Jolt" when they sign up, or null to send nothing (the default). Set by
   * JOLT_WELCOME_MESSAGE, or by JOLT_WELCOME_INVITE alone for the standard welcome with that invite.
   */
  welcomeMessage: string | null;
}

type Env = Record<string, string | undefined>;

const DEFAULT_WELCOME = [
  'Hey {name}, welcome to Jolt! 👋',
  "You're all set. The official Jolt server is where the project is built in the open: updates, help, feedback and people to talk to. Come and say hi:",
  '{invite}',
].join('\n\n');

/** The welcome template, with `\n` in the env var read as a line break and the invite filled in. */
function welcomeMessage(env: Env): string | null {
  const invite = env.JOLT_WELCOME_INVITE?.trim() ?? '';
  const template = env.JOLT_WELCOME_MESSAGE?.trim() || (invite ? DEFAULT_WELCOME : '');
  if (!template) return null;
  return template.replaceAll('\\n', '\n').replaceAll('{invite}', invite);
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (value: string | undefined) => value === 'true' || value === '1';

function oneOf<T extends string>(
  value: string | undefined,
  options: readonly T[],
  fallback: T,
  name: string,
): T {
  if (value === undefined || value === '') return fallback;
  if (!options.includes(value as T)) throw new Error(`${name} must be one of: ${options.join(', ')}`);
  return value as T;
}

export function loadConfig(env: Env = process.env, overrides: Partial<Config> = {}): Config {
  const port = Number(env.JOLT_PORT ?? 4000);
  const domain = normalizeInstance(env.JOLT_DOMAIN ?? `localhost:${port}`);
  if (!isValidInstance(domain)) throw new Error(`JOLT_DOMAIN "${domain}" is not a valid host name`);

  return {
    domain,
    host: env.JOLT_HOST ?? '0.0.0.0',
    port,
    name: env.JOLT_NAME ?? 'Jolt',
    description: env.JOLT_DESCRIPTION ?? '',
    database: env.JOLT_DATABASE ?? './data/jolt.sqlite',
    registration: oneOf(env.JOLT_REGISTRATION, ['open', 'invite', 'closed'], 'open', 'JOLT_REGISTRATION'),
    registrationCodes: list(env.JOLT_REGISTRATION_CODES),
    federation: oneOf(env.JOLT_FEDERATION, ['open', 'allowlist', 'disabled'], 'open', 'JOLT_FEDERATION'),
    federationAllow: list(env.JOLT_FEDERATION_ALLOW).map(normalizeInstance),
    federationBlock: list(env.JOLT_FEDERATION_BLOCK).map(normalizeInstance),
    allowRemoteGuildCreation: bool(env.JOLT_ALLOW_REMOTE_GUILD_CREATION),
    trustProxy: bool(env.JOLT_TRUST_PROXY),
    devInsecure: bool(env.JOLT_DEV_INSECURE),
    workerId: Number(env.JOLT_WORKER_ID ?? 0),
    logLevel: env.JOLT_LOG_LEVEL ?? 'info',
    secretKey: env.JOLT_SECRET_KEY || null,
    welcomeMessage: welcomeMessage(env),
    ...overrides,
  };
}
