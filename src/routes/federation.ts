import { ErrorCode, federationAuthBodySchema, WELL_KNOWN_PATH } from '@jolt/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError, parse } from '../http/errors.js';
import { createChallenge, federatedAuth, instanceInfo, isCertRevoked } from '../services/federation.js';

const strict = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export function wellKnownRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(WELL_KNOWN_PATH, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return instanceInfo(ctx);
  });
}

export function federationRoutes(app: FastifyInstance, ctx: AppContext) {
  const assertEnabled = () => {
    if (ctx.config.federation === 'disabled') {
      throw new ApiError(403, ErrorCode.FederationDenied, 'Federation is disabled on this instance.');
    }
  };

  app.get('/federation/challenge', { config: strict }, async () => {
    assertEnabled();
    return createChallenge(ctx);
  });

  app.post('/federation/auth', { config: strict }, async (req) => {
    assertEnabled();
    return federatedAuth(ctx, parse(federationAuthBodySchema, req.body));
  });

  app.get<{ Params: { serial: string } }>('/federation/certs/:serial', async (req) => ({
    revoked: await isCertRevoked(ctx, req.params.serial),
  }));
}
