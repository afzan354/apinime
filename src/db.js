/**
 * ═══════════════════════════════════════════════════
 *  AnibiPlay API — Database Connection Pool (MySQL)
 * ═══════════════════════════════════════════════════
 *
 *  Mendukung:
 *  - MySQL Lokal (Laragon / XAMPP)
 *  - Serverless Cloud MySQL (TiDB Cloud, Aiven, PlanetScale, cPanel remote)
 *  - Otomatis reconnect dengan Connection Pooling
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

let pool = null;
let isConfigured = false;

function cleanEnv(val, fallback = '') {
  if (!val) return fallback;
  return String(val).trim().replace(/^['"]|['"]$/g, '');
}

function getPool() {
  if (!pool) {
    const host = cleanEnv(process.env.DB_HOST, '127.0.0.1');
    const port = parseInt(cleanEnv(process.env.DB_PORT, '3306'), 10);
    const user = cleanEnv(process.env.DB_USER || process.env.DB_USERNAME, 'root');
    const password = cleanEnv(process.env.DB_PASS || process.env.DB_PASSWORD, '');
    const database = cleanEnv(process.env.DB_NAME || process.env.DB_DATABASE, 'anichin_api');
    
    // Auto-detect SSL jika di TiDB Cloud, Aiven, atau jika DB_SSL=true
    const isCloudHost = host.includes('tidbcloud.com') || host.includes('aivencloud.com');
    const useSsl = String(process.env.DB_SSL).toLowerCase() === 'true' || isCloudHost;

    isConfigured = Boolean(process.env.DB_HOST || process.env.DB_NAME || process.env.DB_DATABASE);

    const poolConfig = {
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      charset: 'utf8mb4',
    };

    if (useSsl) {
      poolConfig.ssl = {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      };
    }

    try {
      pool = mysql.createPool(poolConfig);
    } catch (err) {
      console.error('[DB] Gagal menginisialisasi connection pool:', err.message);
      pool = null;
    }
  }

  return pool;
}

/**
 * Eksekusi query dengan parameter aman (prepared statement)
 */
async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    throw new Error('Database pool belum diinisialisasi.');
  }
  const [rows] = await p.execute(sql, params);
  return rows;
}

/**
 * Tes koneksi database
 */
async function checkDb() {
  try {
    const p = getPool();
    if (!p) return false;
    await p.query('SELECT 1');
    return true;
  } catch (err) {
    console.warn('[DB Ping]', err.message);
    return false;
  }
}

/**
 * Ambil pengaturan dinamis dari tabel settings
 */
async function getSetting(key, defaultVal = '') {
  try {
    const rows = await query('SELECT val FROM settings WHERE `key` = ? LIMIT 1', [key]);
    if (rows && rows.length > 0 && rows[0].val) {
      return rows[0].val;
    }
  } catch (err) {
    // Abaikan jika tabel settings belum dibuat
  }
  return defaultVal;
}

module.exports = {
  getPool,
  query,
  checkDb,
  getSetting,
};
