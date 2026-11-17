# 🍕 jwt-pizza-service

[![CI Pipeline](https://github.com/aearl23/jwt-pizza-service/actions/workflows/ci.yml/badge.svg)](https://github.com/aearl23/jwt-pizza-service/actions/workflows/ci.yml)

![Coverage badge](https://pizza-factory.cs329.click/api/badge/aearl23/jwtpizzaservicecoverage)

Backend service for making JWT pizzas. This service tracks users and franchises and orders pizzas. All order requests are passed to the JWT Pizza Factory where the pizzas are made.

JWTs are used for authentication objects.

## Deployment

In order for the server to work correctly it must be configured by providing a `config.js` file.

```js
module.exports =  {
    // Your JWT secret can be any random string you would like. It just needs to be secret.
   jwtSecret: 'yourjwtsecrethere',
   db: {
   connection: {
      host: '127.0.0.1',
      user: 'root',
      password: 'yourpasswordhere',
      database: 'pizza',
      connectTimeout: 60000,
   },
   listPerPage: 10,
   },
   factory: {
   url: 'https://pizza-factory.cs329.click',
   apiKey: 'yourapikeyhere',
   },
   metrics: {
   source: 'jwt-pizza-service', // use jwt-pizza-service-dev for development
   endpointUrl: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp',
   accountId: 'yourmetricsaccountid',
   apiKey: 'yourmetricsapikey',
   },
   logging: {
   source: 'jwt-pizza-service', // use jwt-pizza-service-dev for development
   endpointUrl: 'https://logs-prod-021.grafana.net/loki/api/v1/push',
   accountId: 'yourlokiaccountid',
   apiKey: 'yourlokiapiKey',
   },
};
```

If `logging` is omitted or any of the three logging values is empty, the service
runs normally and simply does not ship logs.

## Logging

All observability code lives in `src/logger.js` and writes to Grafana Cloud Loki:

| Event | Where it is emitted | What it contains |
| --- | --- | --- |
| `http` | `logger.httpLogger` middleware | method, path, status code, whether an `Authorization` header was sent, request body, response body, duration |
| `db` | `DB.query` / `DB.adminQuery` | SQL statement, parameters, duration, row count, error |
| `factory` | `POST /api/order` | factory request body and factory response body, status, duration |
| `unhandledError` | Express error handler, `uncaughtException`, `unhandledRejection` | message, status code, method/path, truncated stack |

Every entry is sanitized before it leaves the process: passwords, JWTs, bearer
tokens, API keys, cookies and bcrypt hashes are replaced with `[REDACTED]`.

Logs are buffered and flushed to Loki every second.

To generate log traffic against a running service:

```sh
node scripts/simulate-traffic.js https://pizza-service.pizzeriaaaronearl.click 10
```

## Endpoints

You can get the documentation for all endpoints by making the following request.

```sh
curl localhost:3000/api/docs
```

## Development notes

Install the required packages.

```sh
npm install express jsonwebtoken mysql2 bcrypt
```

Nodemon is assumed to be installed globally so that you can have hot reloading when debugging.

```sh
npm -g install nodemon
```
