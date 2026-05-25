# Skarbix Backend

Backend is not initialized yet.

Target direction:

- TypeScript backend.
- Supabase Auth and Supabase Postgres.
- Monobank integration through backend-only API calls.
- OpenAI integration through backend-only API calls.
- Audit logs for all financial and security-sensitive actions.
- API contract for frontend via OpenAPI.

Recommended first backend decisions:

1. Choose framework: NestJS or Fastify.
2. Create staging and production Supabase projects.
3. Define OpenAPI contract before wiring frontend to real data.
4. Add audit log model before money-changing features.
5. Add rate limits for auth, AI, Monobank sync and exports.
