import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}

// Simple logging utility with sanitization for sensitive fields
function sanitizeLog(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const SENSITIVE_KEYS = ['password', 'token', 'accessToken', 'refreshToken', 'email', 'secret', 'authorization'];
  const clone = { ...obj };
  for (const key of SENSITIVE_KEYS) {
    if (clone[key]) {
      clone[key] = '[REDACTED]';
    }
  }
  return clone;
}

export function logInfo(message: string, data?: any) {
  if (data) {
    // eslint-disable-next-line no-console
    console.log(message, sanitizeLog(data));
  } else {
    // eslint-disable-next-line no-console
    console.log(message);
  }
}

export function logError(message: string, data?: any) {
  if (data) {
    // eslint-disable-next-line no-console
    console.error(message, sanitizeLog(data));
  } else {
    // eslint-disable-next-line no-console
    console.error(message);
  }
}
