import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Bucket = { startedAt: number; count: number };

function configuredOrigins() {
  return new Set(
    (process.env.APP_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function corsOrigin(origin: string | undefined) {
  if (!origin) return true;
  return configuredOrigins().has(origin) ? origin : false;
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.APP_HTTPS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function createRateLimiter(options: { windowMs: number; max: number; name: string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let lastCleanup = Date.now();

  return (req, res, next) => {
    if (process.env.APP_RATE_LIMIT_ENABLED === 'false') return next();
    const now = Date.now();
    if (now - lastCleanup > options.windowMs) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.startedAt >= options.windowMs) buckets.delete(key);
      }
      lastCleanup = now;
    }

    const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${options.name}`;
    const current = buckets.get(key);
    const bucket = !current || now - current.startedAt >= options.windowMs
      ? { startedAt: now, count: 0 }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.setHeader('X-RateLimit-Limit', String(options.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((options.windowMs - (now - bucket.startedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ message: '请求过于频繁，请稍后再试' });
      return;
    }
    next();
  };
}
