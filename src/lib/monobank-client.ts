const MONOBANK_API_URL = 'https://api.monobank.ua';

export class MonobankApiError extends Error {
  constructor(public readonly statusCode: number) {
    super(`Monobank request failed with ${statusCode}`);
  }
}

export type MonobankAccount = {
  id: string;
  sendId?: string;
  balance: number;
  creditLimit?: number;
  currencyCode: number;
  cashbackType?: string;
  maskedPan?: string[];
  type?: string;
  iban?: string;
};

export type MonobankClientInfo = {
  clientId?: string;
  name?: string;
  webHookUrl?: string;
  permissions?: string;
  accounts: MonobankAccount[];
};

export type MonobankStatementItem = {
  id: string;
  time: number;
  description?: string;
  mcc?: number;
  originalMcc?: number;
  amount: number;
  operationAmount?: number;
  currencyCode: number;
  commissionRate?: number;
  cashbackAmount?: number;
  balance?: number;
  hold?: boolean;
  receiptId?: string;
  counterEdrpou?: string;
  counterIban?: string;
  counterName?: string;
};

const requestMonobank = async <T>(path: string, token: string): Promise<T> => {
  const response = await fetch(`${MONOBANK_API_URL}${path}`, {
    headers: {
      'X-Token': token,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new MonobankApiError(response.status);
  }

  return response.json() as Promise<T>;
};

export const getMonobankClientInfo = (token: string) =>
  requestMonobank<MonobankClientInfo>('/personal/client-info', token);

export const getMonobankStatement = (token: string, accountId: string, from: number, to: number) =>
  requestMonobank<MonobankStatementItem[]>(`/personal/statement/${accountId}/${from}/${to}`, token);

export const currencyCodeToName = (currencyCode: number) => {
  if (currencyCode === 980) return 'UAH';
  if (currencyCode === 840) return 'USD';
  if (currencyCode === 978) return 'EUR';
  return String(currencyCode);
};

export const kopecksToMajor = (amount: number) => Math.round((amount / 100) * 100) / 100;
