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

function getPool() {
  if (!pool) {
    const host = process.env.DB_HOST || '127.0.0.1';
    const port = parseInt(process.env.DB_PORT || '3306', 10);
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASS || '';
    const database = process.env.DB_NAME || 'anichin_api';
    const useSsl = String(process.env.DB_SSL).toLowerCase() === 'true';

    isConfigured = Boolean(process.env.DB_HOST || process.env.DB_NAME);

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
