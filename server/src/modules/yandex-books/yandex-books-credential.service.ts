import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

@Injectable()
export class YandexBooksCredentialService {
  private readonly key: Buffer | null;
  constructor(config: ConfigService) {
    const raw = config.get<string>('yandexBooks.encryptionKey') ?? '';
    this.key = raw.length === 64 && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex') : null;
  }
  isConfigured(): boolean {
    return this.key !== null;
  }
  encrypt(value: string): string {
    if (!this.key)
      throw new BadRequestException({
        message: 'Set YANDEX_BOOKS_ENCRYPTION_KEY before connecting Yandex Books',
        errorCode: 'YANDEX_BOOKS_ENCRYPTION_KEY_MISSING',
      });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
  }
  decrypt(value: string): string {
    if (!this.key)
      throw new BadRequestException({ message: 'YANDEX_BOOKS_ENCRYPTION_KEY is not set', errorCode: 'YANDEX_BOOKS_ENCRYPTION_KEY_MISSING' });
    try {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new BadRequestException({
        message: 'Stored Yandex Books credentials could not be decrypted',
        errorCode: 'YANDEX_BOOKS_ENCRYPTION_KEY_CHANGED',
      });
    }
  }
}
