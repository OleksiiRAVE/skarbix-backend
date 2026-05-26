import type { FastifyPluginAsync } from 'fastify';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', {
    config: {
      requiresAuth: true,
    },
  }, async (request) => ({
    user: request.user,
  }));
};
