import { ErrorCode } from '@getjolt/protocol';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, ErrorCode.BadRequest, message);
export const unauthorized = (message = 'You need to sign in first.') =>
  new ApiError(401, ErrorCode.Unauthorized, message);
export const forbidden = (message = "You don't have permission to do that.") =>
  new ApiError(403, ErrorCode.Forbidden, message);
export const notFound = (what = 'That') => new ApiError(404, ErrorCode.NotFound, `${what} doesn't exist.`);
export const conflict = (message: string) => new ApiError(409, ErrorCode.Conflict, message);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {});
}

function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | ApiError | ZodError, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message, fields: error.fields } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: ErrorCode.Validation, message: 'Some fields are invalid.', fields: zodFields(error) },
      });
    }
    if (error.statusCode === 429) {
      return reply
        .status(429)
        .send({ error: { code: ErrorCode.RateLimited, message: 'Slow down a little.' } });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: ErrorCode.BadRequest, message: error.message } });
    }
    request.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: ErrorCode.Internal, message: 'Something went wrong on our end.' } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: ErrorCode.NotFound, message: 'Unknown endpoint.' } });
  });
}
