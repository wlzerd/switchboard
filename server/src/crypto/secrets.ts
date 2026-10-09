import crypto from 'node:crypto';
import { KeyError } from '../errors.ts';

const VERSION = 'v1';

/** AES-256-GCM 으로 암호화합니다. 결과: v1:iv:tag:data (각 base64). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new KeyError('secret_format', `저장된 키의 암호문 형식을 알 수 없습니다(버전 '${parts[0] ?? ''}'). DB가 손상되었거나 다른 버전에서 만든 값입니다.`, 500);
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new KeyError(
      'secret_decrypt',
      '저장된 API 키를 복호화하지 못했습니다. SECRETS_KEY 가 키를 저장할 때와 다른 값으로 바뀌었을 수 있습니다. 원래 값으로 되돌리거나 키를 다시 입력하세요.',
      500,
    );
  }
}

/** 타이밍 공격을 피하는 문자열 비교. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(prefix: string, bytes = 9): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hmac(secret: string, text: string): string {
  return crypto.createHmac('sha256', secret).update(text).digest('base64url');
}
