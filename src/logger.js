/**
 * Grafana Cloud (Loki) logging for the JWT Pizza service.
 *
 * Everything that knows how to talk to Grafana lives here so the business code
 * only has to make small, declarative calls:
 *
 *   logger.httpLogger            - Express middleware for every HTTP request
 *   logger.dbLogger(sql, meta)   - database queries and their outcomes
 *   logger.factoryLogger(info)   - requests/responses for the pizza factory
 *   logger.unhandledErrorLogger  - exceptions that escaped a request handler
 *   logger.startLogging()        - periodic batch flush to Grafana Loki
 *
 * Log entries are buffered and pushed in batches. Every entry is sanitized so
 * passwords, JWTs, bearer tokens and API keys never leave the process.
 */

const MAX_ATTEMPTS = 3;
const MAX_BATCH_SIZE = 500;
const MAX_QUEUE_SIZE = 5000;
const MAX_STRING_LENGTH = 8192;
const REDACTED = '[REDACTED]';

// Key names whose values must never be written to the log store. Comparison is
// done on a normalized form (lowercase, separators removed) so that apiKey,
// api_key, and API-KEY all match.
const CONFIDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'auth',
  'apikey',
  'secret',
  'clientsecret',
  'privatekey',
  'jwt',
  'cookie',
  'setcookie',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
]);

class Logger {
  constructor(config = {}) {
    this.config = config;
    this.source = config.source || 'jwt-pizza-service';
    // Accept the names used by the course instructions (endpointUrl/accountId)
    // as well as the older logging.url/userId naming.
    this.endpointUrl = config.endpointUrl || config.url || '';
    this.accountId = config.accountId || config.userId || '';
    this.apiKey = config.apiKey || '';
    this.retryBaseDelayMs = 1000;
    this.queue = [];
    this.flushTimer = null;
    this.flushing = null;
  }

  /** True when the service has been given permission to write logs. */
  isEnabled() {
    return Boolean(this.endpointUrl && this.accountId && this.apiKey);
  }

  /**
   * Express middleware that records the HTTP request event required by the
   * deliverable: method, path, status code, whether an authorization header was
   * present, the request body, and the response body.
   */
  httpLogger = (req, res, next) => {
    const start = process.hrtime.bigint();
    const originalSend = res.send;

    res.send = (body) => {
      // Restore immediately so a second send cannot be logged twice.
      res.send = originalSend;
      try {
        this.logHttpRequest(req, res, body, elapsedMs(start));
      } catch {
        // Logging must never break a response.
      }
      return originalSend.call(res, body);
    };

    next();
  };

  logHttpRequest(req, res, body, durationMs) {
    this.log(this.statusToLogLevel(res.statusCode), 'http', {
      method: (req.method || 'UNKNOWN').toUpperCase(),
      path: req.originalUrl || req.path || '',
      statusCode: res.statusCode,
      authorized: Boolean(req.headers && req.headers.authorization),
      durationMs: Math.round(durationMs * 1000) / 1000,
      requestBody: toPlain(req.body),
      responseBody: toPlain(body),
    });
  }

  /** Record a database query and how it finished. */
  dbLogger(sql, meta = {}) {
    this.log(meta.error ? 'error' : 'info', 'db', {
      sql: typeof sql === 'string' ? sql : String(sql),
      params: sanitizeParams(sql, meta.params),
      durationMs: meta.durationMs === undefined ? undefined : Math.round(meta.durationMs * 1000) / 1000,
      rowCount: meta.rowCount,
      error: meta.error,
    });
  }

  /**
   * Record a request to or a response from the pizza factory.
   * @param {{phase?: string, url?: string, method?: string, requestBody?: any,
   *          responseBody?: any, status?: number, durationMs?: number,
   *          error?: string}} info
   */
  factoryLogger(info = {}) {
    const { phase = 'request', durationMs, ...rest } = info;
    this.log(info.error ? 'error' : 'info', 'factory', {
      phase,
      ...rest,
      durationMs: durationMs === undefined ? undefined : Math.round(durationMs * 1000) / 1000,
    });
  }

  /** Record an exception that was not handled by a request handler. */
  unhandledErrorLogger(err, context = {}) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.log('error', 'unhandledError', {
      ...context,
      message: error.message,
      name: error.name,
      statusCode: error.statusCode,
      // Keep only the top of the stack so a log line stays searchable.
      stack: error.stack ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
    });
  }

  /** Buffer a single log event; no-ops when Grafana is not configured. */
  log(level, type, logData) {
    if (!this.isEnabled()) {
      return null;
    }

    const timestamp = nowNanos();
    const payload = this.sanitize(logData);
    const line = JSON.stringify({
      time: new Date(Number(BigInt(timestamp) / 1000000n)).toISOString(),
      ...normalizeLogData(payload),
      level,
      type,
    });

    const entry = {
      // Stream labels stay low cardinality so Loki can index them cheaply.
      labels: { component: this.source, level, type },
      timestamp,
      line,
    };

    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush();
    }
    return entry;
  }

  /** Recursively remove confidential values from a log payload. */
  sanitize(value) {
    return sanitizeValue(value, 0);
  }

  /** Build the Loki push payload for a batch of entries. */
  toLokiPayload(entries = this.queue) {
    const streams = new Map();
    for (const entry of entries) {
      const key = JSON.stringify(entry.labels);
      let stream = streams.get(key);
      if (!stream) {
        stream = { stream: entry.labels, values: [] };
        streams.set(key, stream);
      }
      stream.values.push([entry.timestamp, entry.line]);
    }
    return { streams: [...streams.values()] };
  }

  /** Push every queued entry to Grafana. Never throws. */
  async flush() {
    if (!this.isEnabled() || this.queue.length === 0) {
      return this.queue.length === 0;
    }
    if (this.flushing) {
      return this.flushing;
    }
    this.flushing = this.flushQueue().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async flushQueue() {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, MAX_BATCH_SIZE);
      const sent = await this.sendLogToGrafana(batch);
      if (!sent) {
        // Leave the batch queued; the next interval will try again.
        return false;
      }
      this.queue.splice(0, batch.length);
    }
    return true;
  }

  /** POST a batch to the Loki push API. Never throws. */
  async sendLogToGrafana(entries) {
    const body = JSON.stringify(this.toLokiPayload(entries));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(lokiEndpoint(this.endpointUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accountId}:${this.apiKey}`,
          },
          body,
        });

        if (response.ok) {
          return true;
        }

        // Grafana Cloud throttles ingestion with 429 and occasionally 5xx.
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
          await delay(attempt * this.retryBaseDelayMs);
          continue;
        }

        console.error(`logging: Grafana rejected logs (${response.status})`);
        return false;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await delay(attempt * this.retryBaseDelayMs);
          continue;
        }
        console.error('logging: unable to send logs to Grafana', err.message);
        return false;
      }
    }

    return false;
  }

  /** Start flushing buffered logs on a fixed interval. */
  startLogging(periodMs = 1000) {
    if (this.flushTimer) {
      return this.flushTimer;
    }
    this.flushTimer = setInterval(() => {
      this.flush();
    }, periodMs);
    this.flushTimer.unref?.();
    return this.flushTimer;
  }

  stopLogging() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  statusToLogLevel(statusCode = 200) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }
}

function normalizeKey(key) {
  return String(key)
    .replace(/[\s_-]/g, '')
    .toLowerCase();
}

function isConfidentialKey(key) {
  return CONFIDENTIAL_KEYS.has(normalizeKey(key));
}

/**
 * Query parameters are positional, so confidential values cannot be found by
 * key name. Instead redact values that are obviously credentials (bcrypt
 * hashes, JWTs, and opaque auth tokens).
 */
function sanitizeParams(sql, params) {
  if (!Array.isArray(params)) {
    return params;
  }
  const mentionsCredential = /(password|token|auth|secret)/i.test(String(sql));
  return params.map((param) => {
    if (typeof param !== 'string') {
      return param;
    }
    if (/^\$2[aby]\$\d{1,2}\$/.test(param)) {
      return REDACTED;
    }
    if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(param)) {
      return REDACTED;
    }
    if (mentionsCredential && /^[A-Za-z0-9_-]{16,}$/.test(param)) {
      return REDACTED;
    }
    return param;
  });
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > 8) {
    return '[DEPTH LIMIT]';
  }
  if (Buffer.isBuffer(value)) {
    value = value.toString('utf8');
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      statusCode: value.statusCode,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isConfidentialKey(key)
        ? REDACTED
        : sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function sanitizeString(value) {
  let text = String(value);
  // Bearer/DPoP style credentials anywhere in a string.
  text = text.replace(/(bearer|dpop)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
  // key=value / key:"value" credentials inside an already serialized string.
  text = text.replace(
    /((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    `$1"${REDACTED}"`
  );
  if (text.length > MAX_STRING_LENGTH) {
    text = `${text.slice(0, MAX_STRING_LENGTH)}... [truncated]`;
  }
  return text;
}

/** Turn a raw body (Buffer, JSON string, object) into something loggable. */
function toPlain(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    value = value.toString('utf8');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }
  return value;
}

/** Sanitized log data must be an object so it can be spread into the line. */
function normalizeLogData(data) {
  if (data === null || data === undefined) {
    return {};
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    return data;
  }
  return { message: data };
}

function nowNanos() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accept either the Loki base URL or the full push URL. */
function lokiEndpoint(endpointUrl) {
  const trimmed = String(endpointUrl).replace(/\/+$/, '');
  if (trimmed.endsWith('/loki/api/v1/push')) {
    return trimmed;
  }
  return `${trimmed}/loki/api/v1/push`;
}

const config = require('./config.js');
const logger = new Logger({ ...(config.logging || {}), factory: config.factory });

module.exports = logger;
module.exports.Logger = Logger;
module.exports.sanitizeValue = sanitizeValue;
