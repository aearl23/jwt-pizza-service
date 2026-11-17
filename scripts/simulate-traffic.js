#!/usr/bin/env node
/**
 * Simulates real user traffic against a running JWT Pizza service so the
 * logging deliverable can be validated in Grafana.
 *
 * Each iteration produces every required log event:
 *   - http   : 200s, a 401, and a 404 (method, path, status, auth header)
 *   - db     : user/menu/order/franchise queries
 *   - factory: the order request and response bodies
 *
 * Usage:
 *   node scripts/simulate-traffic.js [baseUrl] [iterations]
 *
 *   node scripts/simulate-traffic.js https://pizza-service.pizzeriaaaronearl.click 10
 */

const baseUrl = (process.argv[2] || 'https://pizza-service.pizzeriaaaronearl.click').replace(/\/+$/, '');
const iterations = Number(process.argv[3] || 5);
const pauseMs = Number(process.argv[4] || 750);

function log(message) {
  console.log(`[traffic] ${message}`);
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text
  }

  console.log(`  ${method} ${path} -> ${response.status}`);
  return { status: response.status, body: parsed };
}

async function pickFranchiseAndStore() {
  const { body } = await call('GET', '/api/franchise?page=0&limit=5&name=*');
  const franchises = (body && body.franchises) || [];
  for (const franchise of franchises) {
    if (franchise.stores && franchise.stores.length > 0) {
      return { franchiseId: franchise.id, storeId: franchise.stores[0].id };
    }
  }
  return null;
}

async function runIteration(index) {
  const suffix = `${Date.now()}${index}`;
  const email = `traffic-${suffix}@jwt.com`;
  const password = 'traffic-password';

  log(`iteration ${index + 1} of ${iterations}`);

  // Anonymous menu browse (db log).
  await call('GET', '/api/order/menu');

  // Register + login (db logs, bcrypt password hash stays out of the logs).
  const register = await call('POST', '/api/auth', {
    body: { name: `Traffic Diner ${suffix}`, email, password },
  });
  const token = (register.body && register.body.token) || null;

  if (token) {
    await call('GET', '/api/user/me', { token });
    await call('GET', '/api/order', { token });
    await call('GET', '/api/order?page=1', { token });
  }

  // Place an order so the factory request/response bodies are logged.
  const menu = await call('GET', '/api/order/menu');
  const location = await pickFranchiseAndStore();
  if (location && Array.isArray(menu.body) && menu.body.length > 0 && token) {
    const item = menu.body[index % menu.body.length];
    await call('POST', '/api/order', {
      token,
      body: {
        franchiseId: location.franchiseId,
        storeId: location.storeId,
        items: [{ menuId: item.id, description: item.title, price: item.price }],
      },
    });
  }

  // Admin view of the franchise list (db logs).
  await call('GET', '/api/franchise?page=0&limit=3&name=*');

  // Client errors: an unauthorized call and an unknown endpoint.
  await call('GET', '/api/user/me');
  await call('GET', '/api/not-a-real-endpoint');

  if (token) {
    await call('DELETE', '/api/auth', { token });
  }
}

async function main() {
  log(`target: ${baseUrl}`);
  log(`iterations: ${iterations}`);

  const health = await call('GET', '/');
  if (health.status !== 200) {
    throw new Error(`service is not responding at ${baseUrl}`);
  }

  for (let i = 0; i < iterations; i++) {
    await runIteration(i);
    if (i < iterations - 1) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  log('done — open the "JWT Pizza Service Logs" dashboard to see the events');
}

main().catch((err) => {
  console.error(`[traffic] failed: ${err.message}`);
  process.exit(1);
});
