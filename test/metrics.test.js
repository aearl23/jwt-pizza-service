const { EventEmitter } = require('events');
const { Metrics } = require('../src/metrics');

function makeRequest({ method = 'GET', user } = {}) {
  const req = { method, user };
  const res = new EventEmitter();
  const next = jest.fn();
  return { req, res, next };
}

describe('Metrics', () => {
  let metrics;

  beforeEach(() => {
    metrics = new Metrics({
      source: 'jwt-pizza-service-test',
      endpointUrl: 'https://otlp-gateway.example.com/otlp',
      accountId: '123456',
      apiKey: 'glc_test',
    });
    metrics.retryBaseDelayMs = 0;
  });

  afterEach(() => {
    metrics.stopReporting();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('requestTracker counts requests by method and tracks latency', () => {
    for (const method of ['GET', 'GET', 'POST', 'PUT', 'DELETE']) {
      const { req, res, next } = makeRequest({ method });
      metrics.requestTracker(req, res, next);
      expect(next).toHaveBeenCalled();
      res.emit('finish');
    }

    expect(metrics.requestCounts).toEqual({ GET: 2, POST: 1, PUT: 1, DELETE: 1 });
    expect(metrics.requestLatencyCount).toBe(5);
    expect(metrics.requestLatencySumMs).toBeGreaterThanOrEqual(0);
  });

  test('requestTracker records authenticated users as active', () => {
    const { req, res, next } = makeRequest({ user: { id: 7 } });
    metrics.requestTracker(req, res, next);
    res.emit('finish');

    expect([...metrics.activeUsers]).toEqual([7]);
  });

  test('requestTracker ignores anonymous users', () => {
    const { req, res, next } = makeRequest({});
    metrics.requestTracker(req, res, next);
    res.emit('finish');

    expect(metrics.activeUsers.size).toBe(0);
  });

  test('authAttempt counts successes and failures', () => {
    metrics.authAttempt(true);
    metrics.authAttempt(true);
    metrics.authAttempt(false);

    expect(metrics.authAttempts).toEqual({ success: 2, failure: 1 });
  });

  test('pizzaPurchase records sales, revenue, and latency', () => {
    metrics.pizzaPurchase({ success: true, latencyMs: 120, price: 12.5, count: 3 });

    expect(metrics.pizzasSold).toBe(3);
    expect(metrics.pizzaRevenue).toBe(12.5);
    expect(metrics.pizzaCreationFailures).toBe(0);
    expect(metrics.pizzaLatencyCount).toBe(1);
    expect(metrics.pizzaLatencySumMs).toBe(120);
  });

  test('pizzaPurchase records failures without revenue', () => {
    metrics.pizzaPurchase({ success: false, latencyMs: 5000, price: 0, count: 25 });

    expect(metrics.pizzasSold).toBe(0);
    expect(metrics.pizzaRevenue).toBe(0);
    expect(metrics.pizzaCreationFailures).toBe(25);
  });

  test('pizzaPurchase counts a failure when no pizza count is provided', () => {
    metrics.pizzaPurchase({ success: false });
    expect(metrics.pizzaCreationFailures).toBe(1);
  });

  test('cpu and memory usage are percentages', () => {
    const cpu = metrics.cpuUsagePercent();
    const memory = metrics.memoryUsagePercent();

    expect(Number.isFinite(cpu)).toBe(true);
    expect(Number.isFinite(memory)).toBe(true);
    expect(memory).toBeGreaterThanOrEqual(0);
    expect(memory).toBeLessThanOrEqual(100);
  });

  test('toOtlpPayload includes every required metric', () => {
    const { req, res, next } = makeRequest({ method: 'GET', user: { id: 1 } });
    metrics.requestTracker(req, res, next);
    res.emit('finish');
    metrics.authAttempt(true);
    metrics.authAttempt(false);
    metrics.pizzaPurchase({ success: true, latencyMs: 90, price: 5, count: 2 });
    metrics.pizzaPurchase({ success: false, latencyMs: 4000, count: 1 });

    const payload = metrics.toOtlpPayload();
    const scope = payload.resourceMetrics[0].scopeMetrics[0];
    const names = scope.metrics.map((m) => m.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'http_requests_total',
        'auth_attempts_total',
        'active_users',
        'system_cpu_usage_percent',
        'system_memory_usage_percent',
        'http_request_duration_ms',
        'pizzas_sold_total',
        'pizza_creation_failures_total',
        'pizza_revenue_total',
        'pizza_creation_duration_ms',
      ])
    );
    expect(payload.resourceMetrics[0].resource.attributes[0]).toEqual({
      key: 'service.name',
      value: { stringValue: 'jwt-pizza-service-test' },
    });

    const requests = scope.metrics.find((m) => m.name === 'http_requests_total');
    expect(requests.sum.dataPoints[0].attributes).toEqual([
      { key: 'method', value: { stringValue: 'GET' } },
    ]);
    expect(requests.sum.aggregationTemporality).toBe(2);
  });

  test('toOtlpPayload always reports counters, starting at zero', () => {
    const scope = metrics.toOtlpPayload().resourceMetrics[0].scopeMetrics[0];
    const byName = Object.fromEntries(scope.metrics.map((m) => [m.name, m]));

    expect(byName.http_requests_total.sum.dataPoints.map((p) => p.asInt)).toEqual([
      '0',
      '0',
      '0',
      '0',
    ]);
    expect(byName.auth_attempts_total.sum.dataPoints.map((p) => p.asInt)).toEqual(['0', '0']);
    expect(byName.pizzas_sold_total.sum.dataPoints[0].asInt).toBe('0');
    expect(byName.pizza_creation_failures_total.sum.dataPoints[0].asInt).toBe('0');
    expect(byName.pizza_revenue_total.sum.dataPoints[0].asDouble).toBe(0);

    // Latency gauges have no meaning until a request or pizza has been seen.
    expect(byName.http_request_duration_ms).toBeUndefined();
    expect(byName.pizza_creation_duration_ms).toBeUndefined();
    expect(byName.system_cpu_usage_percent).toBeDefined();
  });

  test('sendToGrafana does nothing without configuration', async () => {
    const unconfigured = new Metrics({});
    global.fetch = jest.fn();

    await expect(unconfigured.sendToGrafana()).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sendToGrafana posts an authenticated OTLP payload and clears window metrics', async () => {
    const { req, res, next } = makeRequest({ method: 'POST', user: { id: 2 } });
    metrics.requestTracker(req, res, next);
    res.emit('finish');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await expect(metrics.sendToGrafana()).resolves.toBe(true);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://otlp-gateway.example.com/otlp/v1/metrics');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from('123456:glc_test').toString('base64')}`
    );
    expect(JSON.parse(options.body).resourceMetrics).toBeDefined();

    expect(metrics.activeUsers.size).toBe(0);
    expect(metrics.requestLatencyCount).toBe(0);
  });

  test('sendToGrafana accepts a full metrics URL', async () => {
    const fullUrl = new Metrics({
      endpointUrl: 'https://otlp-gateway.example.com/otlp/v1/metrics',
      accountId: '1',
      apiKey: 'k',
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await fullUrl.sendToGrafana();
    expect(global.fetch.mock.calls[0][0]).toBe('https://otlp-gateway.example.com/otlp/v1/metrics');
  });

  test('sendToGrafana retries after a 429 throttle', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true });

    await expect(metrics.sendToGrafana()).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('sendToGrafana reports a rejected payload', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(metrics.sendToGrafana()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  test('sendToGrafana survives network errors', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(metrics.sendToGrafana()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unable to send'), 'boom');
  });

  test('startReporting flushes on an interval and can be stopped', () => {
    jest.useFakeTimers();
    const send = jest.spyOn(metrics, 'sendToGrafana').mockResolvedValue(true);

    const timer = metrics.startReporting(1000);
    expect(timer).toBeDefined();
    expect(metrics.startReporting(1000)).toBe(timer);

    jest.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(3);

    metrics.stopReporting();
    jest.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(3);

    jest.useRealTimers();
  });
});
