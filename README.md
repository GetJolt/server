# Jolt server

This is the server that runs a Jolt instance. Each instance hosts its own accounts and its own servers, and talks to every other Jolt instance, so people can join a community hosted here using an account from somewhere else. It's one Node.js process and one database file, small enough for a cheap VPS or a computer in the cupboard.

## Run an instance

You'll need a machine with Docker and a domain name pointed at it.

```sh
git clone https://github.com/GetJolt/server.git jolt && cd jolt
cp .env.example .env    # then set JOLT_DOMAIN
docker compose up -d
```

That starts the server along with Caddy, which gets a certificate for your domain and keeps it renewed. Your data lives in the `jolt-data` volume, so that's the thing to back up.

Open the Jolt desktop app, choose Change on the sign in screen, enter your domain and create the first account. If you only want people you know on your instance, set `JOLT_REGISTRATION=invite` and give them one of the codes from `JOLT_REGISTRATION_CODES`.

SQLite is fine for most communities. If you outgrow it, start with `docker compose --profile postgres up -d` and point `JOLT_DATABASE` at the Postgres container. The comment in `docker-compose.yml` has the exact URL.

## Without Docker

```sh
npm install
npm run build
JOLT_DOMAIN=chat.example.org npm start
```

Put it behind a reverse proxy that handles TLS and passes WebSocket upgrades through, and set `JOLT_TRUST_PROXY=true` so rate limits see your visitors' real addresses.

## Configuration

Everything is configured with environment variables, and [.env.example](.env.example) explains each one. The ones that matter most are `JOLT_DOMAIN`, which is the address people and other instances use to reach you, `JOLT_REGISTRATION`, which decides who can sign up, and `JOLT_FEDERATION`, which decides which other instances your users can talk to. You can leave federation open and block the odd bad actor with `JOLT_FEDERATION_BLOCK`, or allow only a few named instances with `allowlist`.

## How it fits together

The server is built on Fastify, with a WebSocket gateway for realtime events and Kysely for the database, so the same code runs against SQLite or Postgres. Messages sit behind a small `MessageStore` interface, which leaves room to move them to something like ScyllaDB on a very large instance without touching anything else.

Users from other instances sign in with a short-lived certificate from their home instance rather than a password. The server checks it against that instance's published keys, and nothing gets copied between instances. Each community's messages stay on the instance that hosts it. The details are in the [protocol repository](https://github.com/GetJolt/protocol/blob/main/PROTOCOL.md).

## The timeline and the fediverse

Besides servers and channels, every instance runs a timeline: posts, replies, reposts, quotes, likes and follows, with images, alt text and content warnings. It's built in the same process and the same database, so there's nothing extra to run.

The timeline speaks ActivityPub, the protocol behind Mastodon. People on Mastodon, Threads, Misskey and other ActivityPub servers can follow your users, and your users can follow them back by looking up an address like `@someone@mastodon.social`. Two Jolt instances federate with each other the same way. Your existing `JOLT_FEDERATION` settings apply here too, so an allowlist or a blocked domain covers both chat and the timeline.

Bluesky users can reach Jolt through [Bridgy Fed](https://fed.brid.gy). It's opt in on both sides: a Jolt user follows `@bsky.brid.gy@bsky.brid.gy` to appear on Bluesky, and Bluesky users follow `@ap.brid.gy` to appear here.

People can also link their Bluesky and Mastodon accounts. A linked account shows on their profile with a verified badge, posts can go out to it at the same time, its home timeline can be read and answered from Jolt, and the people they follow there can be found and followed here. Tokens for linked accounts are encrypted with a key from `JOLT_SECRET_KEY`, or one the server generates next to the SQLite database, and they never leave the server. On a public instance Bluesky reads its OAuth client details from `/oauth/bluesky/client-metadata.json`, so `/oauth/*` must reach the server too.

Delivery to other servers goes through a queue in the database and retries on its own, so a slow or broken server never holds up anyone posting. If you run Caddy or nginx in front of the server yourself, make sure `/users/*`, `/inbox`, `/posts/*`, `/nodeinfo/*`, `/@*`, `/oauth/*` and `/.well-known/*` reach it as well as `/api/*`. Profiles and posts also get public web pages at `/@name` and `/@name/posts/<id>`.

## Development

```sh
npm install
npm run dev     # restarts on changes, listens on localhost:4000
npm test
```

The tests start real instances in memory, including a pair that federate with each other, and drive them with [`@getjolt/sdk`](https://github.com/GetJolt/sdk). To try federation by hand, run two instances on different ports with `JOLT_DEV_INSECURE=true`, which allows plain http between them:

```sh
JOLT_PORT=4100 JOLT_DATABASE=./data/a.sqlite JOLT_DEV_INSECURE=true npm run dev
JOLT_PORT=4200 JOLT_DATABASE=./data/b.sqlite JOLT_DEV_INSECURE=true npm run dev
```

## License

The server is licensed under the AGPL-3.0, which means that if you run a modified version for other people, you need to share your changes with them. The protocol and SDK are MIT licensed, so building clients and tools on top of Jolt has no such requirement.
