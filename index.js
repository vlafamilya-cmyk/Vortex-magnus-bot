const { startDashboard } = require('./dashboard/server');
const { createBotRuntime } = require('./utils/botRuntime');
const { createLogger } = require('./utils/logger');
const { loadConfig } = require('./utils/config');

async function main() {
  const logger = createLogger();
  const config = loadConfig();
  const runtime = createBotRuntime({ config, logger });
  const server = await startDashboard({ config, logger, runtime });
  await runtime.start().catch(err => logger.error('BOT_START_FAILED', { error: err.message }));
  const shutdown = async () => {
    logger.info('SHUTDOWN_REQUESTED');
    await runtime.stop().catch(err => logger.warn('BOT_STOP_FAILED', { error: err.message }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(err => { console.error('Fatal startup error:', err.message); process.exitCode = 1; });
