import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const getKey = () => createHash('sha256')
  .update(env.MONOBANK_TOKEN_ENCRYPTION_KEY || `${env.SUPABASE_SERVICE_ROLE_KEY}:monobank`)
  .digest();

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export const encryptSecret = (secret: string): EncryptedSecret => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
};

export const decryptSecret = (encrypted: EncryptedSecret) => {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};
