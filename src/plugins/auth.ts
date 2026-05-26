import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      email?: string;
    };
  }
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest('user');

  app.addHook('preHandler', async (request) => {
    if (!request.routeOptions.config.requiresAuth) {
      return;
    }

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

    if (!token) {
      throw app.httpErrors.unauthorized('Missing bearer token');
    }

    const { data, error } = await app.supabase.auth.getUser(token);

    if (error || !data.user) {
      throw app.httpErrors.unauthorized('Invalid bearer token');
    }

    request.user = {
      id: data.user.id,
      email: data.user.email,
    };
  });
});

declare module 'fastify' {
  interface FastifyContextConfig {
    requiresAuth?: boolean;
  }
}
