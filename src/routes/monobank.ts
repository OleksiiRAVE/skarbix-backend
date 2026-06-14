import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env, hasMonobankProviderConfig } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../lib/secret-box.js';
import {
  currencyCodeToName,
  getMonobankClientInfo,
  getMonobankStatement,
  kopecksToMajor,
  MonobankApiError,
  type MonobankAccount,
  type MonobankClientInfo,
  type MonobankStatementItem,
} from '../lib/monobank-client.js';
import {
  checkMonobankAuthorization,
  createMonobankAuthorizationRequest,
  getProviderMonobankClientInfo,
  getProviderMonobankStatement,
  setProviderMonobankWebhook,
} from '../lib/monobank-provider-client.js';

const connectSchema = z.object({
  token: z.string().trim().min(20).max(512),
});

const webhookParamsSchema = z.object({
  secret: z.string().min(1),
});

const callbackQuerySchema = z.object({
  secret: z.string().min(1),
});

const statementItemSchema = z.object({
  id: z.string().min(1),
  time: z.number().int().positive(),
  description: z.string().optional(),
  mcc: z.number().optional(),
  originalMcc: z.number().optional(),
  amount: z.number(),
  operationAmount: z.number().optional(),
  currencyCode: z.number(),
  commissionRate: z.number().optional(),
  cashbackAmount: z.number().optional(),
  balance: z.number().optional(),
  hold: z.boolean().optional(),
  receiptId: z.string().optional(),
  counterEdrpou: z.string().optional(),
  counterIban: z.string().optional(),
  counterName: z.string().optional(),
});

const webhookSchema = z.object({
  type: z.string(),
  data: z.object({
    account: z.string().min(1),
    statementItem: statementItemSchema,
  }),
});

type StoredConnection = {
  auth_mode: 'personal_token' | 'provider';
  status: 'pending' | 'connected' | 'revoked' | 'error';
  token_ciphertext: string | null;
  token_iv: string | null;
  token_auth_tag: string | null;
  token_request_id: string | null;
  accept_url: string | null;
  client_name: string | null;
  last_sync_at: string | null;
  imported_transactions: number | null;
  webhook_enabled: boolean | null;
};

type ImportedAccount = {
  id: string;
  external_id: string | null;
};

const MONOBANK_SOURCE = 'monobank';
const MAX_INITIAL_SYNC_DAYS = 30;
const isMonoRateLimit = (error: unknown) =>
  error instanceof MonobankApiError && error.statusCode === 429;

const safeSecretEqual = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer);
};

const monoAccountName = (account: MonobankAccount) => {
  const maskedPan = account.maskedPan?.[0];
  if (maskedPan) return `Monobank ${maskedPan.slice(-4)}`;
  if (account.type) return `Monobank ${account.type}`;
  return 'Monobank';
};

const transactionRow = (
  userId: string,
  accountId: string,
  item: MonobankStatementItem,
) => ({
  user_id: userId,
  account_id: accountId,
  category_id: null,
  type: item.amount >= 0 ? 'income' : 'expense',
  amount: Math.abs(kopecksToMajor(item.amount)),
  currency: currencyCodeToName(item.currencyCode),
  merchant: item.description || item.counterName || 'Monobank transaction',
  notes: item.counterName ? `Counterparty: ${item.counterName}` : null,
  occurred_at: new Date(item.time * 1000).toISOString(),
  source: MONOBANK_SOURCE,
  external_id: item.id,
  updated_at: new Date().toISOString(),
});

const writeAuditLog = async (
  app: FastifyInstance,
  userId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) => {
  const { error } = await app.supabase.from('audit_logs').insert({
    user_id: userId,
    action,
    entity_type: 'monobank_connection',
    metadata,
  });
  if (error) app.log.warn({ error, action }, 'Could not write Monobank audit event');
};

const upsertAccounts = async (
  app: FastifyInstance,
  userId: string,
  clientInfo: MonobankClientInfo,
) => {
  if (!clientInfo.accounts.length) return [];

  const rows = clientInfo.accounts.map((account) => ({
    user_id: userId,
    name: monoAccountName(account),
    type: 'card',
    currency: currencyCodeToName(account.currencyCode),
    balance: kopecksToMajor(account.balance),
    color: '#111827',
    icon: 'lucide:credit-card',
    is_archived: false,
    external_source: MONOBANK_SOURCE,
    external_id: account.id,
    masked_pan: account.maskedPan?.[0] ?? null,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await app.supabase
    .from('accounts')
    .upsert(rows, { onConflict: 'user_id,external_source,external_id' })
    .select('id,external_id');

  if (error) throw error;
  return (data ?? []) as ImportedAccount[];
};

const syncTransactions = async (
  app: FastifyInstance,
  userId: string,
  clientInfo: MonobankClientInfo,
  accounts: ImportedAccount[],
  getStatement: (accountId: string, from: number, to: number) => Promise<MonobankStatementItem[]>,
  lastSyncAt?: string | null,
) => {
  const now = Math.floor(Date.now() / 1000);
  const earliest = now - MAX_INITIAL_SYNC_DAYS * 24 * 60 * 60;
  const from = Math.max(
    earliest,
    lastSyncAt ? Math.floor(new Date(lastSyncAt).getTime() / 1000) - 60 * 60 : earliest,
  );
  let imported = 0;
  let limited = false;

  for (const account of clientInfo.accounts) {
    const dbAccount = accounts.find((item) => item.external_id === account.id);
    if (!dbAccount) continue;

    let statement: MonobankStatementItem[];
    try {
      statement = await getStatement(account.id, from, now);
    } catch (error) {
      if (isMonoRateLimit(error)) {
        limited = true;
        break;
      }
      throw error;
    }
    if (!statement.length) continue;

    const rows = statement.map((item) => transactionRow(userId, dbAccount.id, item));
    const { data, error } = await app.supabase
      .from('transactions')
      .upsert(rows, { onConflict: 'user_id,source,external_id', ignoreDuplicates: true })
      .select('id');

    if (error) throw error;
    imported += data?.length ?? 0;
  }

  return { imported, limited };
};

const getStoredConnection = async (app: FastifyInstance, userId: string) => {
  const { data, error } = await app.supabase
    .from('monobank_connections')
    .select([
      'auth_mode',
      'status',
      'token_ciphertext',
      'token_iv',
      'token_auth_tag',
      'token_request_id',
      'accept_url',
      'client_name',
      'last_sync_at',
      'imported_transactions',
      'webhook_enabled',
    ].join(','))
    .eq('user_id', userId)
    .maybeSingle<StoredConnection>();

  if (error) throw error;
  return data;
};

const completeProviderConnection = async (
  app: FastifyInstance,
  userId: string,
  connection: StoredConnection,
) => {
  if (!connection.token_request_id) throw app.httpErrors.badRequest('Authorization request is missing');

  const requestId = connection.token_request_id;
  const clientInfo = await getProviderMonobankClientInfo(requestId);
  const accounts = await upsertAccounts(app, userId, clientInfo);
  const syncResult = await syncTransactions(
    app,
    userId,
    clientInfo,
    accounts,
    (accountId, from, to) => getProviderMonobankStatement(requestId, accountId, from, to),
    connection.last_sync_at,
  );

  let webhookEnabled = false;
  try {
    await setProviderMonobankWebhook();
    webhookEnabled = true;
  } catch (error) {
    app.log.warn({ error, userId }, 'Could not configure Monobank provider webhook');
  }

  const totalImported = (connection.imported_transactions ?? 0) + syncResult.imported;
  const now = new Date().toISOString();
  const { error } = await app.supabase
    .from('monobank_connections')
    .update({
      status: 'connected',
      client_id: clientInfo.clientId ?? null,
      client_name: clientInfo.name ?? 'Monobank',
      accept_url: null,
      authorized_at: now,
      webhook_enabled: webhookEnabled,
      imported_transactions: totalImported,
      last_sync_at: now,
      updated_at: now,
    })
    .eq('user_id', userId);

  if (error) throw error;
  await writeAuditLog(app, userId, 'monobank.provider.connected', {
    accountsImported: accounts.length,
    transactionsImported: syncResult.imported,
    webhookEnabled,
  });

  return {
    connected: true,
    status: 'connected' as const,
    authMode: 'provider' as const,
    accountName: clientInfo.name ?? 'Monobank',
    webhookEnabled,
    importedTransactions: totalImported,
    accountsImported: accounts.length,
    imported: syncResult.imported,
    syncLimited: syncResult.limited,
  };
};

export const monobankRoutes: FastifyPluginAsync = async (app) => {
  app.get('/monobank/status', {
    config: { requiresAuth: true },
  }, async (request) => {
    const data = await getStoredConnection(app, request.user.id);
    return {
      connected: data?.status === 'connected',
      status: data?.status ?? 'disconnected',
      authMode: data?.auth_mode,
      acceptUrl: data?.status === 'pending' ? data.accept_url ?? undefined : undefined,
      accountName: data?.client_name ?? undefined,
      lastSync: data?.last_sync_at ?? undefined,
      webhookEnabled: data?.webhook_enabled ?? false,
      importedTransactions: data?.imported_transactions ?? 0,
      providerAvailable: hasMonobankProviderConfig,
    };
  });

  app.post('/monobank/provider/authorize', {
    config: {
      requiresAuth: true,
      rateLimit: { max: 5, timeWindow: '10 minutes' },
    },
  }, async (request) => {
    if (!hasMonobankProviderConfig) {
      throw app.httpErrors.serviceUnavailable('Monobank provider API is not configured');
    }

    const authorization = await createMonobankAuthorizationRequest();
    const now = new Date().toISOString();
    const { error } = await app.supabase.from('monobank_connections').upsert({
      user_id: request.user.id,
      auth_mode: 'provider',
      status: 'pending',
      token_ciphertext: null,
      token_iv: null,
      token_auth_tag: null,
      token_request_id: authorization.tokenRequestId,
      accept_url: authorization.acceptUrl,
      client_id: null,
      client_name: null,
      webhook_enabled: false,
      imported_transactions: 0,
      last_sync_at: null,
      authorized_at: null,
      updated_at: now,
    }, { onConflict: 'user_id' });

    if (error) throw error;
    await writeAuditLog(app, request.user.id, 'monobank.provider.authorization_requested');

    return {
      connected: false,
      status: 'pending',
      authMode: 'provider',
      acceptUrl: authorization.acceptUrl,
      webhookEnabled: false,
      importedTransactions: 0,
      providerAvailable: true,
    };
  });

  app.post('/monobank/provider/confirm', {
    config: {
      requiresAuth: true,
      rateLimit: { max: 30, timeWindow: '5 minutes' },
    },
  }, async (request) => {
    const connection = await getStoredConnection(app, request.user.id);
    if (!connection || connection.auth_mode !== 'provider' || !connection.token_request_id) {
      throw app.httpErrors.notFound('Monobank authorization request was not found');
    }
    if (connection.status === 'connected') {
      return {
        connected: true,
        status: 'connected',
        authMode: 'provider',
        accountName: connection.client_name ?? undefined,
        webhookEnabled: connection.webhook_enabled ?? false,
        importedTransactions: connection.imported_transactions ?? 0,
        providerAvailable: true,
      };
    }

    try {
      await checkMonobankAuthorization(connection.token_request_id);
    } catch (error) {
      if (error instanceof MonobankApiError && error.statusCode === 401) {
        return {
          connected: false,
          status: 'pending',
          authMode: 'provider',
          acceptUrl: connection.accept_url ?? undefined,
          webhookEnabled: false,
          importedTransactions: 0,
          providerAvailable: true,
        };
      }
      throw error;
    }

    return completeProviderConnection(app, request.user.id, connection);
  });

  app.get('/monobank/provider/callback', async (request) => {
    const query = callbackQuerySchema.safeParse(request.query);
    const requestId = request.headers['x-request-id'];
    const expectedSecret = env.MONOBANK_PROVIDER_WEBHOOK_SECRET;
    if (
      !query.success ||
      !expectedSecret ||
      !safeSecretEqual(query.data.secret, expectedSecret) ||
      typeof requestId !== 'string'
    ) {
      throw app.httpErrors.notFound();
    }

    const { data, error } = await app.supabase
      .from('monobank_connections')
      .select('user_id')
      .eq('token_request_id', requestId)
      .eq('auth_mode', 'provider')
      .maybeSingle<{ user_id: string }>();

    if (error) throw error;
    if (!data) throw app.httpErrors.notFound();
    return { received: true };
  });

  app.post('/monobank/provider/webhook/:secret', {
    config: {
      rateLimit: { max: 600, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const params = webhookParamsSchema.safeParse(request.params);
    const expectedSecret = env.MONOBANK_PROVIDER_WEBHOOK_SECRET;
    if (!params.success || !expectedSecret || !safeSecretEqual(params.data.secret, expectedSecret)) {
      throw app.httpErrors.notFound();
    }

    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      // Monobank checks a new webhook with an empty POST before saving it.
      return reply.status(200).send({ received: true });
    }

    const requestId = request.headers['x-request-id'];
    const { data: linkedAccount, error: accountLookupError } = await app.supabase
      .from('accounts')
      .select('id,user_id')
      .eq('external_source', MONOBANK_SOURCE)
      .eq('external_id', parsed.data.data.account)
      .maybeSingle<{ id: string; user_id: string }>();

    if (accountLookupError) throw accountLookupError;
    if (!linkedAccount) throw app.httpErrors.unauthorized('Unknown Monobank account');

    let connectionQuery = app.supabase
      .from('monobank_connections')
      .select('user_id,token_request_id,imported_transactions')
      .eq('user_id', linkedAccount.user_id)
      .eq('auth_mode', 'provider')
      .eq('status', 'connected');
    if (typeof requestId === 'string') {
      connectionQuery = connectionQuery.eq('token_request_id', requestId);
    }
    const { data: connection, error: connectionError } = await connectionQuery
      .maybeSingle<{
        user_id: string;
        token_request_id: string;
        imported_transactions: number | null;
      }>();

    if (connectionError) throw connectionError;
    if (!connection) throw app.httpErrors.unauthorized('Unknown Monobank connection');

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(parsed.data))
      .digest('hex');
    const { error: eventError } = await app.supabase.from('monobank_webhook_events').insert({
      token_request_id: connection.token_request_id,
      external_id: parsed.data.data.statementItem.id,
      event_type: parsed.data.type,
      payload_hash: payloadHash,
    });

    if (eventError?.code === '23505') {
      return reply.status(200).send({ received: true, duplicate: true });
    }
    if (eventError) throw eventError;

    try {
      const item = parsed.data.data.statementItem;
      const { error: transactionError } = await app.supabase
        .from('transactions')
        .upsert(transactionRow(connection.user_id, linkedAccount.id, item), {
          onConflict: 'user_id,source,external_id',
        });
      if (transactionError) throw transactionError;

      if (typeof item.balance === 'number') {
        const { error: balanceError } = await app.supabase
          .from('accounts')
          .update({
            balance: kopecksToMajor(item.balance),
            updated_at: new Date().toISOString(),
          })
          .eq('id', linkedAccount.id)
          .eq('user_id', connection.user_id);
        if (balanceError) throw balanceError;
      }

      const now = new Date().toISOString();
      const { error: updateError } = await app.supabase
        .from('monobank_connections')
        .update({
          imported_transactions: (connection.imported_transactions ?? 0) + 1,
          last_sync_at: now,
          last_webhook_at: now,
          updated_at: now,
        })
        .eq('user_id', connection.user_id);
      if (updateError) throw updateError;

      await app.supabase
        .from('monobank_webhook_events')
        .update({ processed_at: now })
        .eq('token_request_id', connection.token_request_id)
        .eq('payload_hash', payloadHash);

      return reply.status(200).send({ received: true });
    } catch (error) {
      await app.supabase
        .from('monobank_webhook_events')
        .update({ error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error' })
        .eq('token_request_id', connection.token_request_id)
        .eq('payload_hash', payloadHash);
      throw error;
    }
  });

  // Temporary compatibility endpoint for existing personal-token users.
  app.post('/monobank/connect', {
    config: { requiresAuth: true },
  }, async (request) => {
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest('Invalid Monobank token');

    let clientInfo: MonobankClientInfo;
    try {
      clientInfo = await getMonobankClientInfo(parsed.data.token);
    } catch {
      throw app.httpErrors.badRequest('Could not connect Monobank. Check your token and try again.');
    }

    const encrypted = encryptSecret(parsed.data.token);
    const accounts = await upsertAccounts(app, request.user.id, clientInfo);
    const syncResult = await syncTransactions(
      app,
      request.user.id,
      clientInfo,
      accounts,
      (accountId, from, to) => getMonobankStatement(parsed.data.token, accountId, from, to),
    );

    const { error } = await app.supabase.from('monobank_connections').upsert({
      user_id: request.user.id,
      auth_mode: 'personal_token',
      status: 'connected',
      token_ciphertext: encrypted.ciphertext,
      token_iv: encrypted.iv,
      token_auth_tag: encrypted.authTag,
      token_request_id: null,
      accept_url: null,
      client_id: clientInfo.clientId ?? null,
      client_name: clientInfo.name ?? 'Monobank',
      webhook_enabled: Boolean(clientInfo.webHookUrl),
      last_sync_at: new Date().toISOString(),
      imported_transactions: syncResult.imported,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    if (error) throw error;
    return {
      connected: true,
      status: 'connected',
      authMode: 'personal_token',
      accountName: clientInfo.name ?? 'Monobank',
      webhookEnabled: Boolean(clientInfo.webHookUrl),
      importedTransactions: syncResult.imported,
      accountsImported: accounts.length,
      syncLimited: syncResult.limited,
    };
  });

  app.post('/monobank/sync', {
    config: {
      requiresAuth: true,
      rateLimit: { max: 10, timeWindow: '10 minutes' },
    },
  }, async (request) => {
    const connection = await getStoredConnection(app, request.user.id);
    if (!connection || connection.status !== 'connected') {
      throw app.httpErrors.notFound('Monobank is not connected');
    }

    if (connection.auth_mode === 'provider') {
      if (!connection.token_request_id) throw app.httpErrors.badRequest('Provider request id is missing');
      const clientInfo = await getProviderMonobankClientInfo(connection.token_request_id);
      const accounts = await upsertAccounts(app, request.user.id, clientInfo);
      const syncResult = await syncTransactions(
        app,
        request.user.id,
        clientInfo,
        accounts,
        (accountId, from, to) =>
          getProviderMonobankStatement(connection.token_request_id!, accountId, from, to),
        connection.last_sync_at,
      );
      const totalImported = (connection.imported_transactions ?? 0) + syncResult.imported;
      const { error } = await app.supabase
        .from('monobank_connections')
        .update({
          client_name: clientInfo.name ?? connection.client_name,
          last_sync_at: new Date().toISOString(),
          imported_transactions: totalImported,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', request.user.id);
      if (error) throw error;

      return {
        imported: syncResult.imported,
        importedTransactions: totalImported,
        accountsImported: accounts.length,
        syncLimited: syncResult.limited,
      };
    }

    if (!connection.token_ciphertext || !connection.token_iv || !connection.token_auth_tag) {
      throw app.httpErrors.badRequest('Personal Monobank token is missing');
    }
    const token = decryptSecret({
      ciphertext: connection.token_ciphertext,
      iv: connection.token_iv,
      authTag: connection.token_auth_tag,
    });
    const clientInfo = await getMonobankClientInfo(token);
    const accounts = await upsertAccounts(app, request.user.id, clientInfo);
    const syncResult = await syncTransactions(
      app,
      request.user.id,
      clientInfo,
      accounts,
      (accountId, from, to) => getMonobankStatement(token, accountId, from, to),
      connection.last_sync_at,
    );
    const totalImported = (connection.imported_transactions ?? 0) + syncResult.imported;
    const { error } = await app.supabase
      .from('monobank_connections')
      .update({
        client_name: clientInfo.name ?? connection.client_name,
        last_sync_at: new Date().toISOString(),
        imported_transactions: totalImported,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', request.user.id);
    if (error) throw error;

    return {
      imported: syncResult.imported,
      importedTransactions: totalImported,
      accountsImported: accounts.length,
      syncLimited: syncResult.limited,
    };
  });

  app.delete('/monobank/disconnect', {
    config: { requiresAuth: true },
  }, async (request) => {
    const { error } = await app.supabase
      .from('monobank_connections')
      .delete()
      .eq('user_id', request.user.id);
    if (error) throw error;

    await writeAuditLog(app, request.user.id, 'monobank.disconnected');
    return {
      connected: false,
      status: 'disconnected',
      webhookEnabled: false,
      importedTransactions: 0,
      providerAvailable: hasMonobankProviderConfig,
    };
  });
};
