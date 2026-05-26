# Skarbix Backend

Fastify + TypeScript backend for security-sensitive Skarbix workflows.

## What Lives Here

- Supabase Auth JWT verification.
- Backend-only Supabase service role usage.
- Monobank integration, later.
- OpenAI integration, later.
- Audit logs for financial and security-sensitive actions.
- OpenAPI contract.

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run start
```

## Required Env

Copy `.env.example` to `.env` locally and fill backend-only values:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CORS_ORIGINS
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the frontend.

## Endpoints

```text
GET /health
GET /ready
GET /v1/me
```

`/v1/me` requires:

```text
Authorization: Bearer <supabase-user-jwt>
```

## Database

Initial SQL lives in:

```text
migrations/001_initial_finance_schema.sql
```

It creates the first finance tables and enables RLS.
