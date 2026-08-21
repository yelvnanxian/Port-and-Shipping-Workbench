import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
let writeChain: Promise<void> = Promise.resolve();

function redactPath(value: string) {
  return value
    .replace(/([?&](?:key|token|password|secret|csrf)=)[^&]*/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)[^,\s]+/gi, '$1[REDACTED]');
}

export function auditLog(dataDirectory: string, event: string, details: Record<string, unknown> = {}) {
  const filePath = path.join(dataDirectory, 'audit.log');
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redactPath(value).slice(0, 500) : value])),
  }) + '\n';
  writeChain = writeChain.then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    try {
      const stat = await fs.stat(filePath);
      if (stat.size + Buffer.byteLength(entry) > MAX_LOG_BYTES) {
        for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
          await fs.rename(`${filePath}.${index}`, `${filePath}.${index + 1}`).catch(() => undefined);
        }
        await fs.rename(filePath, `${filePath}.1`).catch(() => undefined);
      }
    } catch { /* 首次写入 */ }
    await fs.appendFile(filePath, entry, { mode: 0o600 });
  }).catch(() => undefined);
  return writeChain;
}

export function auditMiddleware(dataDirectory: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      void auditLog(dataDirectory, 'api.request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        userId: req.authUser?.id || null,
        username: req.authUser?.username || null,
        ip: req.ip || req.socket.remoteAddress || 'unknown',
      });
    });
    next();
  };
}
