# Skarbix Backend

Fastify + TypeScript backend for security-sensitive Skarbix workflows.

## What Lives Here

- Supabase Auth JWT verification.
- Backend-only Supabase service role usage.
- Monobank provider authorization, QR consent, statement import and webhook
  synchronization.
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
GET /v1/monobank/status
POST /v1/monobank/provider/authorize
POST /v1/monobank/provider/confirm
POST /v1/monobank/sync
DELETE /v1/monobank/disconnect
```

`/v1/me` requires:

```text
Authorization: Bearer <supabase-user-jwt>
```

## Database

Database migrations live in:

```text
migrations/001_initial_finance_schema.sql
migrations/002_monobank_provider.sql
```

It creates the first finance tables and enables RLS.
