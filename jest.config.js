module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/index.js', '!src/init.js', '!src/config.js'],
  coverageThreshold: {
    global: {
      lines: 80,
    },
  },
  coverageReporters: ['text', 'json-summary'],
};
