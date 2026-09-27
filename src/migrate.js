// One-off script: applies schema.sql to whatever DATABASE_URL points at.
// Run locally with `npm run migrate`, or once via Render's Shell tab after
// the first deploy (see backend README, "Adım 6").
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema.sql ...');
  await pool.query(schema);
  console.log('Schema applied successfully.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
