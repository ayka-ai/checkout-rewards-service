import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp(db, config);

const server = app.listen(config.port, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  // A parent process (the multi-instance test) reads this line to learn the port.
  console.log(
    `LISTENING port=${port} db=${config.dbPath} n=${config.rewardEveryNOrders} x=${config.rewardDiscountPercent}%`,
  );
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
