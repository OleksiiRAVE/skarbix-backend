import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().min(1).default('http://localhost:5173'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  MONOBANK_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  MONOBANK_PROVIDER_KEY_ID: z.string().min(20).optional(),
  MONOBANK_PROVIDER_PRIVATE_KEY_BASE64: z.string().min(100).optional(),
  MONOBANK_PROVIDER_CALLBACK_URL: z.string().url().optional(),
  MONOBANK_PROVIDER_WEBHOOK_URL: z.string().url().optional(),
  MONOBANK_PROVIDER_WEBHOOK_SECRET: z.string().min(32).optional(),
  DEEPSEEK_API_KEY: z.string().min(20).optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-v4-flash'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables');
  console.error(z.treeifyError(parsedEnv.error));
  process.exit(1);
}

export const env = {
  ...parsedEnv.data,
  CORS_ORIGINS: parsedEnv.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export const isProduction = env.NODE_ENV === 'production';

export const hasMonobankProviderConfig = Boolean(
  env.MONOBANK_PROVIDER_KEY_ID &&
  env.MONOBANK_PROVIDER_PRIVATE_KEY_BASE64 &&
  env.MONOBANK_PROVIDER_CALLBACK_URL &&
  env.MONOBANK_PROVIDER_WEBHOOK_URL &&
  env.MONOBANK_PROVIDER_WEBHOOK_SECRET
);

export const hasDeepSeekConfig = Boolean(env.DEEPSEEK_API_KEY);
