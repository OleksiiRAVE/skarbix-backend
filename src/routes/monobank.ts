import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../lib/secret-box.js';
import {
  currencyCodeToName,
  getMonobankClientInfo,
  getMonobankStatement,
  kopecksToMajor,
  MonobankApiError,
  type MonobankAccount,
  type MonobankClientInfo,
} from '../lib/monobank-client.js';

const connectSchema = z.object({
  token: z.string().trim().min(20).max(512),
});

type StoredConnection = {
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
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
const isMonoRateLimit = (error: unknown) => error instanceof MonobankApiError && error.statusCode === 429;

const monoAccountName = (account: MonobankAccount) => {
  const maskedPan = account.maskedPan?.[0];
  if (maskedPan) return `Monobank ${maskedPan.slice(-4)}`;
  if (account.type) return `Monobank ${account.type}`;
  return 'Monobank';
};

const upsertAccounts = async (
  app: Parameters<FastifyPluginAsync>[0],
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
  app: Parameters<FastifyPluginAsync>[0],
  userId: string,
  token: string,
  clientInfo: MonobankClientInfo,
  accounts: ImportedAccount[],
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

    let statement;
    try {
      statement = await getMonobankStatement(token, account.id, from, now);
    } catch (error) {
      if (isMonoRateLimit(error)) {
        limited = true;
        break;
      }
      throw error;
    }
    if (!statement.length) continue;

    const rows = statement.map((item) => {
      const isIncome = item.amount >= 0;
      const counterparty = item.counterName ? `Counterparty: ${item.counterName}` : null;

      return {
        user_id: userId,
        account_id: dbAccount.id,
        category_id: null,
        type: isIncome ? 'income' : 'expense',
        amount: Math.abs(kopecksToMajor(item.amount)),
        currency: currencyCodeToName(item.currencyCode),
        merchant: item.description || item.counterName || 'Monobank transaction',
        notes: counterparty,
        occurred_at: new Date(item.time * 1000).toISOString(),
        source: MONOBANK_SOURCE,
        external_id: item.id,
        updated_at: new Date().toISOString(),
      };
    });

    const { data, error } = await app.supabase
      .from('transactions')
      .upsert(rows, { onConflict: 'user_id,source,external_id', ignoreDuplicates: true })
      .select('id');

    if (error) throw error;
    imported += data?.length ?? 0;
  }

  return { imported, limited };
};

export const monobankRoutes: FastifyPluginAsync = async (app) => {
  app.get('/monobank/status', {
    config: {
      requiresAuth: true,
    },
  }, async (request) => {
    const { data, error } = await app.supabase
      .from('monobank_connections')
      .select('client_name,last_sync_at,imported_transactions,webhook_enabled')
      .eq('user_id', request.user.id)
      .maybeSingle();

    if (error) throw error;

    return {
      connected: Boolean(data),
      accountName: data?.client_name ?? undefined,
      lastSync: data?.last_sync_at ?? undefined,
      webhookEnabled: data?.webhook_enabled ?? false,
      importedTransactions: data?.imported_transactions ?? 0,
    };
  });

  app.post('/monobank/connect', {
    config: {
      requiresAuth: true,
    },
  }, async (request) => {
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest('Invalid Monobank token');
    }

    let clientInfo: MonobankClientInfo;
    try {
      clientInfo = await getMonobankClientInfo(parsed.data.token);
    } catch {
      throw app.httpErrors.badRequest('Could not connect Monobank. Check your token and try again.');
    }

    const encrypted = encryptSecret(parsed.data.token);
    const accounts = await upsertAccounts(app, request.user.id, clientInfo);
    let syncResult = { imported: 0, limited: false };
    let syncLimited = false;
    try {
      syncResult = await syncTransactions(app, request.user.id, parsed.data.token, clientInfo, accounts);
      syncLimited = syncResult.limited;
    } catch (error) {
      if (!isMonoRateLimit(error)) throw error;
      syncLimited = true;
    }

    const { error } = await app.supabase
      .from('monobank_connections')
      .upsert({
        user_id: request.user.id,
        token_ciphertext: encrypted.ciphertext,
        token_iv: encrypted.iv,
        token_auth_tag: encrypted.authTag,
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
      accountName: clientInfo.name ?? 'Monobank',
      webhookEnabled: Boolean(clientInfo.webHookUrl),
      importedTransactions: syncResult.imported,
      accountsImported: accounts.length,
      syncLimited,
    };
  });

  app.post('/monobank/sync', {
    config: {
      requiresAuth: true,
    },
  }, async (request) => {
    const { data, error } = await app.supabase
      .from('monobank_connections')
      .select('token_ciphertext,token_iv,token_auth_tag,client_name,last_sync_at,imported_transactions,webhook_enabled')
      .eq('user_id', request.user.id)
      .maybeSingle<StoredConnection>();

    if (error) throw error;
    if (!data) throw app.httpErrors.notFound('Monobank is not connected');

    const token = decryptSecret({
      ciphertext: data.token_ciphertext,
      iv: data.token_iv,
      authTag: data.token_auth_tag,
    });
    const clientInfo = await getMonobankClientInfo(token);
    const accounts = await upsertAccounts(app, request.user.id, clientInfo);
    let syncResult = { imported: 0, limited: false };
    let syncLimited = false;
    try {
      syncResult = await syncTransactions(app, request.user.id, token, clientInfo, accounts, data.last_sync_at);
      syncLimited = syncResult.limited;
    } catch (error) {
      if (!isMonoRateLimit(error)) throw error;
      syncLimited = true;
    }
    const totalImported = (data.imported_transactions ?? 0) + syncResult.imported;

    const { error: updateError } = await app.supabase
      .from('monobank_connections')
      .update({
        client_name: clientInfo.name ?? data.client_name,
        webhook_enabled: Boolean(clientInfo.webHookUrl),
        last_sync_at: new Date().toISOString(),
        imported_transactions: totalImported,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', request.user.id);

    if (updateError) throw updateError;

    return {
      imported: syncResult.imported,
      importedTransactions: totalImported,
      accountsImported: accounts.length,
      syncLimited,
    };
  });

  app.delete('/monobank/disconnect', {
    config: {
      requiresAuth: true,
    },
  }, async (request) => {
    const { error } = await app.supabase
      .from('monobank_connections')
      .delete()
      .eq('user_id', request.user.id);

    if (error) throw error;

    return {
      connected: false,
      webhookEnabled: false,
      importedTransactions: 0,
    };
  });
};
