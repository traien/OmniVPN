const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.WEBUI_PASSWORD;
const COOKIE_NAME = 'omnivpn_session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

if (!ADMIN_PASSWORD) {
  throw new Error('WEBUI_PASSWORD must be set.');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function passwordMatches(candidate) {
  return safeEqual(candidate, ADMIN_PASSWORD);
}

function isAuthenticated(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function authMiddleware(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
}

function sessionCookieOptions(req) {
  const secure = process.env.WEBUI_SECURE_COOKIE === 'true';

  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS
  };
}

function setSessionCookie(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MAX_AGE_MS);
  res.cookie(COOKIE_NAME, token, sessionCookieOptions(req));
}

function clearSessionCookie(req, res) {
  const token = req.cookies[COOKIE_NAME];
  if (token) sessions.delete(token);
  const options = sessionCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
}

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}, 60 * 60 * 1000);
sessionCleanup.unref();

function createRateLimiter({ windowMs, max, message }) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "font-src 'self'"
  ].join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

function sameOriginMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-origin request rejected.' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  return next();
}

module.exports = {
  authMiddleware,
  clearSessionCookie,
  createRateLimiter,
  isAuthenticated,
  passwordMatches,
  sameOriginMiddleware,
  securityHeaders,
  setSessionCookie
};
