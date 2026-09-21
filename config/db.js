const { Pool } = require('pg');

require('dotenv').config();

const useSsl = process.env.PGSSLMODE === 'require' || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  family: 4, // Use IPv4
});

pool.on('connect', () => {
  console.log('PostgreSQL connection established');
});

module.exports = pool;
