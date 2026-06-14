import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { env } from './config/env.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { supabasePlugin } from './plugins/supabase.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { monobankRoutes } from './routes/monobank.js';
import { aiRoutes } from './routes/ai.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    genReqId(request) {
      const incomingRequestId = request.headers['x-request-id'];
      if (typeof incomingRequestId === 'string' && incomingRequestId.length <= 128) {
        return incomingRequestId;
      }
      return crypto.randomUUID();
    },
  });

  await app.register(securityPlugin);
  await app.register(supabasePlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(monobankRoutes, { prefix: '/v1' });
  await app.register(aiRoutes, { prefix: '/v1' });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);

    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const message = statusCode >= 500 ? 'Internal server error' : error.message;

    void reply.status(statusCode).send({
      error: {
        message,
        statusCode,
        requestId: request.id,
      },
    });
  });

  return app;
}
