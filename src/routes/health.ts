import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'skarbix-backend',
  }));

  app.get('/ready', async () => {
    const { error } = await app.supabase.from('profiles').select('id').limit(1);

    return {
      status: error ? 'degraded' : 'ok',
      checks: {
        supabase: error ? 'error' : 'ok',
      },
    };
  });
};
