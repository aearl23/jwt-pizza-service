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

const config = {
  jwtSecret,
  db: {
    connection: {
      host: '127.0.0.1',
      user: 'root',
      password: 'tempdbpassword',
      database: 'pizza',
      connectTimeout: 60000,
    },
    listPerPage: 10,
  },
  factory: {
    url: 'https://pizza-factory.cs329.click',
    apiKey: factoryApiKey,
  },
};

fs.writeFileSync('src/config.js', `module.exports = ${JSON.stringify(config, null, 2)};\n`);
