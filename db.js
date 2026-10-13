const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  // Fail fast and loud rather than silently connecting to nothing.
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
}

// Render's managed Postgres requires SSL; local Postgres usually does not.
const useSsl = process.env.DATABASE_URL.includes('render.com') || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  // A background/idle client error should not crash the whole process.
  console.error('Unexpected Postgres pool error', err);
});

module.exports = { pool };
