import { createPool } from "../src/db/pool.js";
import { migrateWithRetry } from "../src/db/migrate.js";
import { loadConfig, loadLocalEnv } from "../src/config.js";
import { Logger } from "../src/logger.js";

loadLocalEnv();
const config = loadConfig();
const logger = new Logger(config.logLevel);

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(config.databaseUrl, logger);
try {
  const applied = await migrateWithRetry(pool, logger);
  process.stdout.write(
    applied.length
      ? `Applied ${applied.length} migration(s): ${applied.join(", ")}\n`
      : "Database is already up to date.\n"
  );
} finally {
  await pool.end();
}
