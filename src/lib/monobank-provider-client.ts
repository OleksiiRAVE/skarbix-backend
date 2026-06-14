import { createSign } from 'node:crypto';
import { env, hasMonobankProviderConfig } from '../config/env.js';
import {
  MonobankApiError,
  type MonobankClientInfo,
  type MonobankStatementItem,
} from './monobank-client.js';

const MONOBANK_API_URL = 'https://api.monobank.ua';

type ProviderRequestOptions = {
  method?: 'GET' | 'POST';
  requestId?: string;
  callbackUrl?: string;
  body?: unknown;
};

export type MonobankAuthorizationRequest = {
  tokenRequestId: string;
  acceptUrl: string;
};

const providerConfig = () => {
  if (!hasMonobankProviderConfig) {
    throw new Error('Monobank provider API is not configured');
  }

  return {
    keyId: env.MONOBANK_PROVIDER_KEY_ID!,
    privateKey: Buffer.from(env.MONOBANK_PROVIDER_PRIVATE_KEY_BASE64!, 'base64').toString('utf8'),
    callbackUrl: env.MONOBANK_PROVIDER_CALLBACK_URL!,
    webhookUrl: `${env.MONOBANK_PROVIDER_WEBHOOK_URL!}/${env.MONOBANK_PROVIDER_WEBHOOK_SECRET!}`,
  };
};

const signPayload = (payload: string) => {
  const signer = createSign('SHA256');
  signer.update(payload);
  signer.end();
  return signer.sign({
    key: providerConfig().privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
};

const providerRequest = async <T>(path: string, options: ProviderRequestOptions = {}): Promise<T> => {
  const config = providerConfig();
  const time = Math.floor(Date.now() / 1000).toString();
  const payload = `${time}${options.requestId ?? ''}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Key-Id': config.keyId,
    'X-Time': time,
    'X-Sign': signPayload(payload),
  };

  if (options.requestId) headers['X-Request-Id'] = options.requestId;
  if (options.callbackUrl) headers['X-Callback'] = options.callbackUrl;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${MONOBANK_API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new MonobankApiError(response.status, text);
  }

  if (!text) return {} as T;
  return JSON.parse(text) as T;
};

export const createMonobankAuthorizationRequest = () => {
  const config = providerConfig();
  return providerRequest<MonobankAuthorizationRequest>('/personal/auth/request', {
    method: 'POST',
    callbackUrl: `${config.callbackUrl}?secret=${encodeURIComponent(env.MONOBANK_PROVIDER_WEBHOOK_SECRET!)}`,
  });
};

export const checkMonobankAuthorization = (requestId: string) =>
  providerRequest<Record<string, never>>('/personal/auth/request', { requestId });

export const getProviderMonobankClientInfo = (requestId: string) =>
  providerRequest<MonobankClientInfo>('/personal/client-info', { requestId });

export const getProviderMonobankStatement = (
  requestId: string,
  accountId: string,
  from: number,
  to: number,
) => providerRequest<MonobankStatementItem[]>(
  `/personal/statement/${encodeURIComponent(accountId)}/${from}/${to}`,
  { requestId },
);

export const setProviderMonobankWebhook = () =>
  providerRequest<Record<string, never>>('/personal/corp/webhook', {
    method: 'POST',
    body: {
      webHookUrl: providerConfig().webhookUrl,
    },
  });
