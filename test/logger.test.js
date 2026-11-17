const { Logger, sanitizeValue } = require('../src/logger');

function makeLogger(overrides = {}) {
  return new Logger({
    source: 'jwt-pizza-service-test',
    endpointUrl: 'https://logs-prod.example.com',
    accountId: '123456',
    apiKey: 'glc_test',
    ...overrides,
  });
}

function makeExchange({ method = 'GET', url = '/', headers = {}, body, statusCode = 200 } = {}) {
  const req = { method, originalUrl: url, headers, body };
  const res = {
    statusCode,
    sentBody: undefined,
    send(payload) {
      this.sentBody = payload;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

function readEntry(entry) {
  return JSON.parse(entry.line);
}

describe('Logger', () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
    logger.retryBaseDelayMs = 0;
  });

  afterEach(() => {
    logger.stopLogging();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('is disabled when Grafana credentials are missing', () => {
    const unconfigured = new Logger({ source: 'x' });
    expect(unconfigured.isEnabled()).toBe(false);
    expect(unconfigured.log('info', 'http', { path: '/' })).toBeNull();
    expect(unconfigured.queue).toHaveLength(0);
  });

  test('supports the older url/userId configuration names', () => {
    const legacy = new Logger({ url: 'https://logs.example.com', userId: '9', apiKey: 'k' });
    expect(legacy.isEnabled()).toBe(true);
    expect(legacy.endpointUrl).toBe('https://logs.example.com');
    expect(legacy.accountId).toBe('9');
  });

  describe('httpLogger', () => {
    test('logs method, path, status, auth header, request and response bodies', () => {
      const { req, res, next } = makeExchange({
        method: 'post',
        url: '/api/auth?x=1',
        headers: { authorization: 'Bearer tttttt' },
        body: { email: 'd@jwt.com', password: 'diner' },
        statusCode: 200,
      });

      logger.httpLogger(req, res, next);
      expect(next).toHaveBeenCalled();

      res.send({ user: { id: 2 }, token: 'secret-jwt' });

      expect(logger.queue).toHaveLength(1);
      const entry = logger.queue[0];
      expect(entry.labels).toEqual({
        component: 'jwt-pizza-service-test',
        level: 'info',
        type: 'http',
      });

      const line = readEntry(entry);
      expect(line.method).toBe('POST');
      expect(line.path).toBe('/api/auth?x=1');
      expect(line.statusCode).toBe(200);
      expect(line.authorized).toBe(true);
      expect(line.requestBody).toEqual({ email: 'd@jwt.com', password: '[REDACTED]' });
      expect(line.responseBody).toEqual({ user: { id: 2 }, token: '[REDACTED]' });
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('records that no authorization header was sent', () => {
      const { req, res, next } = makeExchange({ url: '/api/order/menu' });

      logger.httpLogger(req, res, next);
      res.send([{ id: 1, title: 'Veggie' }]);

      const line = readEntry(logger.queue[0]);
      expect(line.authorized).toBe(false);
      expect(line.responseBody).toEqual([{ id: 1, title: 'Veggie' }]);
    });

    test('parses a JSON string response body', () => {
      const { req, res, next } = makeExchange();

      logger.httpLogger(req, res, next);
      res.send('{"message":"welcome to JWT Pizza"}');

      const line = readEntry(logger.queue[0]);
      expect(line.responseBody).toEqual({ message: 'welcome to JWT Pizza' });
    });

    test('uses warn for 4xx and error for 5xx responses', () => {
      for (const [statusCode, level] of [
        [404, 'warn'],
        [500, 'error'],
      ]) {
        logger.queue.length = 0;
        const { req, res, next } = makeExchange({ statusCode });
        logger.httpLogger(req, res, next);
        res.send({ message: 'nope' });
        expect(logger.queue[0].labels.level).toBe(level);
      }
    });

    test('restores res.send so a second call is not logged twice', () => {
      const { req, res, next } = makeExchange();
      logger.httpLogger(req, res, next);

      res.send({ ok: true });
      res.send({ ok: true });

      expect(logger.queue).toHaveLength(1);
    });
  });

  describe('dbLogger', () => {
    test('logs SQL, params and row count', () => {
      logger.dbLogger('SELECT * FROM menu', { params: [], durationMs: 2.5, rowCount: 3 });

      const entry = logger.queue[0];
      expect(entry.labels.type).toBe('db');
      expect(entry.labels.level).toBe('info');
      expect(readEntry(entry)).toMatchObject({
        sql: 'SELECT * FROM menu',
        params: [],
        durationMs: 2.5,
        rowCount: 3,
      });
    });

    test('redacts password parameters', () => {
      logger.dbLogger('INSERT INTO user (name, email, password) VALUES (?, ?, ?)', {
        params: ['diner', 'd@jwt.com', '$2b$10$hash'],
      });

      const line = readEntry(logger.queue[0]);
      expect(line.params[1]).toBe('d@jwt.com');
      expect(JSON.stringify(line)).not.toContain('$2b$10$hash');
    });

    test('logs failures at error level', () => {
      logger.dbLogger('SELECT 1', { error: 'boom' });

      expect(logger.queue[0].labels.level).toBe('error');
      expect(readEntry(logger.queue[0]).error).toBe('boom');
    });
  });

  describe('factoryLogger', () => {
    test('logs the factory request body', () => {
      logger.factoryLogger({
        phase: 'request',
        method: 'POST',
        url: 'https://pizza-factory.cs329.click/api/order',
        requestBody: { diner: { id: 1, name: 'diner' }, order: { id: 4 } },
      });

      const entry = logger.queue[0];
      expect(entry.labels.type).toBe('factory');
      expect(readEntry(entry)).toMatchObject({
        phase: 'request',
        requestBody: { diner: { id: 1, name: 'diner' }, order: { id: 4 } },
      });
    });

    test('logs the factory response body and redacts the order JWT', () => {
      logger.factoryLogger({
        phase: 'response',
        status: 200,
        durationMs: 12,
        responseBody: { jwt: 'factory-jwt', reportUrl: 'https://report' },
      });

      const line = readEntry(logger.queue[0]);
      expect(line.status).toBe(200);
      expect(line.responseBody.jwt).toBe('[REDACTED]');
      expect(line.responseBody.reportUrl).toBe('https://report');
    });

    test('logs factory transport failures at error level', () => {
      logger.factoryLogger({ phase: 'response', error: 'ECONNRESET' });

      expect(logger.queue[0].labels.level).toBe('error');
      expect(readEntry(logger.queue[0]).error).toBe('ECONNRESET');
    });
  });

  describe('unhandledErrorLogger', () => {
    test('logs the exception message, status and a trimmed stack', () => {
      const err = new Error('unknown user');
      err.statusCode = 404;

      logger.unhandledErrorLogger(err, { method: 'PUT', path: '/api/auth' });

      const entry = logger.queue[0];
      expect(entry.labels.type).toBe('unhandledError');
      expect(entry.labels.level).toBe('error');

      const line = readEntry(entry);
      expect(line.message).toBe('unknown user');
      expect(line.statusCode).toBe(404);
      expect(line.method).toBe('PUT');
      expect(line.stack.split('\n').length).toBeLessThanOrEqual(8);
    });

    test('accepts a non-Error value', () => {
      logger.unhandledErrorLogger('it broke');
      expect(readEntry(logger.queue[0]).message).toBe('it broke');
    });
  });

  describe('sanitization', () => {
    test('redacts confidential keys at any depth', () => {
      const sanitized = sanitizeValue({
        user: { email: 'd@jwt.com', password: 'diner', apiKey: 'glc_x' },
        nested: [{ token: 'abc', authorization: 'Bearer abc' }],
        safe: 'keep me',
      });

      expect(sanitized).toEqual({
        user: { email: 'd@jwt.com', password: '[REDACTED]', apiKey: '[REDACTED]' },
        nested: [{ token: '[REDACTED]', authorization: '[REDACTED]' }],
        safe: 'keep me',
      });
    });

    test('redacts credentials embedded in strings', () => {
      const sanitized = sanitizeValue('password=admin and Authorization: Bearer abc.def.ghi');

      expect(sanitized).not.toContain('admin');
      expect(sanitized).not.toContain('abc.def.ghi');
      expect(sanitized).toContain('[REDACTED]');
    });

    test('truncates very long strings', () => {
      const sanitized = sanitizeValue('x'.repeat(20000));
      expect(sanitized.length).toBeLessThan(20000);
      expect(sanitized).toContain('[truncated]');
    });

    test('handles buffers, dates, errors and depth limits', () => {
      const sanitized = sanitizeValue({
        buffer: Buffer.from('hello'),
        date: new Date('2026-01-01T00:00:00.000Z'),
        error: new Error('bad'),
      });

      expect(sanitized.buffer).toBe('hello');
      expect(sanitized.date).toBe('2026-01-01T00:00:00.000Z');
      expect(sanitized.error).toEqual({ name: 'Error', message: 'bad', statusCode: undefined });

      let deep = 'end';
      for (let i = 0; i < 12; i++) {
        deep = { deep };
      }
      expect(JSON.stringify(sanitizeValue(deep))).toContain('DEPTH LIMIT');
    });
  });

  describe('Loki payload', () => {
    test('groups entries into streams by label set', () => {
      logger.log('info', 'http', { path: '/a' });
      logger.log('info', 'http', { path: '/b' });
      logger.log('error', 'db', { sql: 'SELECT 1' });

      const payload = logger.toLokiPayload();
      expect(payload.streams).toHaveLength(2);

      const http = payload.streams.find((s) => s.stream.type === 'http');
      expect(http.values).toHaveLength(2);
      expect(http.values[0][0]).toMatch(/^\d+$/);
      expect(JSON.parse(http.values[0][1]).path).toBe('/a');
    });
  });

  describe('sendLogToGrafana', () => {
    test('posts a batch with the Grafana bearer credential', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      logger.log('info', 'http', { path: '/' });

      await expect(logger.flush()).resolves.toBe(true);

      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe('https://logs-prod.example.com/loki/api/v1/push');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer 123456:glc_test');
      expect(JSON.parse(options.body).streams).toHaveLength(1);
      expect(logger.queue).toHaveLength(0);
    });

    test('accepts the full push URL', async () => {
      const fullUrl = makeLogger({
        endpointUrl: 'https://logs-prod.example.com/loki/api/v1/push/',
      });
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      fullUrl.log('info', 'http', { path: '/' });

      await fullUrl.flush();
      expect(global.fetch.mock.calls[0][0]).toBe('https://logs-prod.example.com/loki/api/v1/push');
    });

    test('does nothing when the queue is empty', async () => {
      global.fetch = jest.fn();
      await expect(logger.flush()).resolves.toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('retries after a 429 throttle', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true });
      logger.log('info', 'http', { path: '/' });

      await expect(logger.flush()).resolves.toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('keeps entries queued when Grafana rejects them', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      logger.log('info', 'http', { path: '/' });

      await expect(logger.flush()).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('401'));
      expect(logger.queue).toHaveLength(1);
    });

    test('survives network errors', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = jest.fn().mockRejectedValue(new Error('boom'));
      logger.log('info', 'http', { path: '/' });

      await expect(logger.flush()).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('unable to send'), 'boom');
    });

    test('flushes in batches of at most 500 entries', async () => {
      const many = makeLogger();
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      for (let i = 0; i < 1200; i++) {
        many.queue.push({ labels: { component: 'x', level: 'info', type: 'db' }, timestamp: String(i), line: '{}' });
      }

      await many.flush();
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(many.queue).toHaveLength(0);
    });
  });

  describe('startLogging', () => {
    test('flushes on an interval and can be stopped', () => {
      jest.useFakeTimers();
      const flush = jest.spyOn(logger, 'flush').mockResolvedValue(true);

      const timer = logger.startLogging(1000);
      expect(timer).toBeDefined();
      expect(logger.startLogging(1000)).toBe(timer);

      jest.advanceTimersByTime(3000);
      expect(flush).toHaveBeenCalledTimes(3);

      logger.stopLogging();
      jest.advanceTimersByTime(1000);
      expect(flush).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });
  });
});
