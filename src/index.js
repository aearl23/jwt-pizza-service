const app = require('./service.js');
const metrics = require('./metrics.js');
const logger = require('./logger.js');

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  metrics.startReporting();
  logger.startLogging();
});

// Last resort logging for exceptions that escape every request handler.
process.on('unhandledRejection', (reason) => {
  logger.unhandledErrorLogger(reason, { source: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  logger.unhandledErrorLogger(err, { source: 'uncaughtException' });
  console.error('Uncaught exception', err);
});
