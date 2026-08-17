import crypto from 'node:crypto';

export function getClientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function createRateLimiter({
  windowMs = 60_000,
  max = 100,
  keyGenerator = getClientKey,
  maxKeys = 10_000,
} = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  }

  function middleware(req, res, next) {
    const now = Date.now();
    prune(now);
    const key = String(keyGenerator(req));
    const current = hits.get(key);
    const entry = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };

    entry.count += 1;
    hits.set(key, entry);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  }

  middleware.reset = () => hits.clear();
  middleware.size = () => hits.size;
  return middleware;
}

export function requireAdminToken({ token = process.env.ADMIN_API_TOKEN } = {}) {
  return (req, res, next) => {
    if (!token) return res.status(404).json({ error: 'Not found' });
    const authorization = String(req.get('authorization') || '');
    const supplied = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expected = Buffer.from(token);
    const actual = Buffer.from(supplied);
    const valid = expected.length === actual.length
      && crypto.timingSafeEqual(expected, actual);
    if (!valid) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}
