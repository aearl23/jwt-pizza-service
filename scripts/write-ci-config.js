const fs = require('fs');

const jwtSecret = process.env.JWT_SECRET;
const factoryApiKey = process.env.FACTORY_API_KEY;

if (!jwtSecret) {
  console.error('Missing JWT_SECRET. Add a JWT_SECRET repository secret in GitHub Actions settings.');
  process.exit(1);
}

if (!factoryApiKey) {
  console.error('Missing FACTORY_API_KEY. Add a FACTORY_API_KEY repository secret in GitHub Actions settings.');
  process.exit(1);
}

// Database settings default to the ephemeral MySQL service used for tests,
// but can be overridden with environment variables for the production
// deployment (RDS).
const config = {
  jwtSecret,
  db: {
    connection: {
      host: process.env.DB_HOST || '127.0.0.1',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'tempdbpassword',
      database: process.env.DB_NAME || 'pizza',
      connectTimeout: 60000,
    },
    listPerPage: 10,
  },
  factory: {
    url: process.env.FACTORY_URL || 'https://pizza-factory.cs329.click',
    apiKey: factoryApiKey,
  },
};

fs.writeFileSync('src/config.js', `module.exports = ${JSON.stringify(config, null, 2)};\n`);
