const os = require('os');

const MAX_ATTEMPTS = 3;

/**
 * Collects application metrics and ships them to Grafana Cloud (OTLP/HTTP).
 *
 * The rest of the service only talks to the small public API at the bottom of
 * this file, which keeps the observability concerns isolated from business
 * logic:
 *
 *   metrics.requestTracker        - Express middleware for HTTP metrics
 *   metrics.authAttempt(success)  - login success/failure
 *   metrics.pizzaPurchase({...})  - pizza sale, revenue, latency, failures
 *   metrics.startReporting()      - periodic flush to Grafana
 */
class Metrics {
  constructor(config = {}) {
    this.config = config;
    this.retryBaseDelayMs = 1000;
    this.reset();
    this.reportingTimer = null;
  }

  reset() {
    this.requestCounts = {};
    this.requestLatencySumMs = 0;
    this.requestLatencyCount = 0;
    this.authAttempts = { success: 0, failure: 0 };
    this.activeUsers = new Set();
    this.pizzasSold = 0;
    this.pizzaCreationFailures = 0;
    this.pizzaRevenue = 0;
    this.pizzaLatencySumMs = 0;
    this.pizzaLatencyCount = 0;
  }

  /** Express middleware that records every request by method, status, and latency. */
  requestTracker = (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const method = (req.method || 'UNKNOWN').toUpperCase();
      this.requestCounts[method] = (this.requestCounts[method] || 0) + 1;
      this.requestLatencySumMs += Number(process.hrtime.bigint() - start) / 1e6;
      this.requestLatencyCount += 1;

      if (req.user && req.user.id !== undefined) {
        this.activeUsers.add(req.user.id);
      }
    });

    next();
  };

  /** Record a login attempt. */
  authAttempt(success) {
    if (success) {
      this.authAttempts.success += 1;
    } else {
      this.authAttempts.failure += 1;
    }
  }

  /**
   * Record the outcome of a pizza purchase.
   * @param {{success: boolean, latencyMs: number, price: number, count: number}} purchase
   */
  pizzaPurchase({ success, latencyMs = 0, price = 0, count = 0 }) {
    if (success) {
      this.pizzasSold += count;
      this.pizzaRevenue += price;
    } else {
      this.pizzaCreationFailures += count || 1;
    }
    this.pizzaLatencySumMs += latencyMs;
    this.pizzaLatencyCount += 1;
  }

  cpuUsagePercent() {
    const cpuUsage = os.loadavg()[0] / os.cpus().length;
    return Number((cpuUsage * 100).toFixed(2));
  }

  memoryUsagePercent() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return Number((((totalMemory - freeMemory) / totalMemory) * 100).toFixed(2));
  }

  /** Build the OTLP/JSON payload for the current snapshot. */
  toOtlpPayload() {
    const time = nowNanos();
    const metrics = [];

    const methodPoints = Object.entries(this.requestCounts).map(([method, count]) => ({
      attributes: [attribute('method', method)],
      asInt: String(count),
      timeUnixNano: time,
    }));
    if (methodPoints.length > 0) {
      metrics.push(sum('http_requests_total', '', methodPoints));
    }

    const authPoints = Object.entries(this.authAttempts)
      .filter(([, count]) => count > 0)
      .map(([result, count]) => ({
        attributes: [attribute('result', result)],
        asInt: String(count),
        timeUnixNano: time,
      }));
    if (authPoints.length > 0) {
      metrics.push(sum('auth_attempts_total', '', authPoints));
    }

    metrics.push(gauge('active_users', '', this.activeUsers.size));
    metrics.push(gauge('system_cpu_usage_percent', '', this.cpuUsagePercent()));
    metrics.push(gauge('system_memory_usage_percent', '', this.memoryUsagePercent()));

    if (this.requestLatencyCount > 0) {
      metrics.push(
        gauge('http_request_duration_ms', '', this.requestLatencySumMs / this.requestLatencyCount)
      );
    }

    if (this.pizzasSold > 0) {
      metrics.push(sum('pizzas_sold_total', '', [intPoint(this.pizzasSold, time)]));
    }
    if (this.pizzaCreationFailures > 0) {
      metrics.push(
        sum('pizza_creation_failures_total', '', [intPoint(this.pizzaCreationFailures, time)])
      );
    }
    if (this.pizzaRevenue > 0) {
      metrics.push(sum('pizza_revenue_total', '', [doublePoint(this.pizzaRevenue, time)]));
    }
    if (this.pizzaLatencyCount > 0) {
      metrics.push(
        gauge('pizza_creation_duration_ms', '', this.pizzaLatencySumMs / this.pizzaLatencyCount)
      );
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attribute('service.name', this.config.source || 'jwt-pizza-service'),
              attribute('service.namespace', 'jwt-pizza'),
              attribute('host.name', os.hostname()),
            ],
          },
          scopeMetrics: [
            {
              scope: { name: 'jwt-pizza-service', version: '1.0.0' },
              metrics,
            },
          ],
        },
      ],
    };
  }

  /** Push the current snapshot to Grafana Cloud. Never throws. */
  async sendToGrafana() {
    const { endpointUrl, accountId, apiKey } = this.config;
    if (!endpointUrl || !accountId || !apiKey) {
      return false;
    }

    const payload = this.toOtlpPayload();
    // Latency averages describe a single reporting window.
    this.requestLatencySumMs = 0;
    this.requestLatencyCount = 0;
    this.pizzaLatencySumMs = 0;
    this.pizzaLatencyCount = 0;
    this.activeUsers.clear();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(otlpEndpoint(endpointUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          return true;
        }

        // Grafana Cloud throttles ingestion with 429 and occasionally returns 5xx.
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
          await delay(attempt * this.retryBaseDelayMs);
          continue;
        }

        console.error(`metrics: Grafana rejected payload (${response.status})`);
        return false;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await delay(attempt * this.retryBaseDelayMs);
          continue;
        }
        console.error('metrics: unable to send metrics to Grafana', err.message);
        return false;
      }
    }

    return false;
  }

  /** Flush metrics on a fixed interval. */
  startReporting(periodMs = 10000) {
    if (this.reportingTimer) {
      return this.reportingTimer;
    }
    this.reportingTimer = setInterval(() => {
      this.sendToGrafana();
    }, periodMs);
    this.reportingTimer.unref?.();
    return this.reportingTimer;
  }

  stopReporting() {
    if (this.reportingTimer) {
      clearInterval(this.reportingTimer);
      this.reportingTimer = null;
    }
  }
}

function nowNanos() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attribute(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function intPoint(value, time) {
  return { asInt: String(value), timeUnixNano: time };
}

function doublePoint(value, time) {
  return { asDouble: Number(value), timeUnixNano: time };
}

function gauge(name, unit, value, attributes = []) {
  return {
    name,
    unit,
    gauge: {
      dataPoints: [{ attributes, asDouble: Number(value), timeUnixNano: nowNanos() }],
    },
  };
}

function sum(name, unit, dataPoints) {
  return {
    name,
    unit,
    sum: {
      dataPoints,
      aggregationTemporality: 2, // cumulative
      isMonotonic: true,
    },
  };
}

/** Accept either the OTLP base URL or the full metrics URL. */
function otlpEndpoint(endpointUrl) {
  const trimmed = endpointUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/metrics')) {
    return trimmed;
  }
  return `${trimmed}/v1/metrics`;
}

const config = require('./config.js');
const metrics = new Metrics(config.metrics || {});

module.exports = metrics;
module.exports.Metrics = Metrics;
