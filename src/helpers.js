/**
 * ═══════════════════════════════════════════════════
 *  AnibiPlay API — Helper Functions & Formatters
 * ═══════════════════════════════════════════════════
 *  Sesuai spesifikasi rules.md v1.0
 */

const crypto = require('crypto');
const { query } = require('./db');

// Cache TTL konstanta dalam detik
const CACHE_HOME = 60;
const CACHE_SERIES = 300;
const CACHE_SCHEDULE = 600;
const CACHE_GENRES = 86400;
const CACHE_PLAY = 86400 * 30; // 30 hari (embed URL video sifatnya permanen)

// In-memory cache sederhana untuk serverless cold-start efficiency
const memoryCache = new Map();

/**
 * Base URL sumber anime (anichin)
 */
function getSourceBaseUrl() {
  const url = process.env.SOURCE_BASE_URL || 'https://anichin.moe';
  return url.replace(/\/+$/, '');
}

/**
 * Ubah relative URL menjadi absolute URL
 */
function makeAbsolute(url, baseUrl = null) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  const base = (baseUrl || getSourceBaseUrl()).replace(/\/+$/, '');
  return `${base}/${url.replace(/^\/+/, '')}`;
}

/**
 * Buat slug URL-friendly
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Format tanggal ke ISO-8601 UTC string (contoh: 2026-10-18T14:30:00Z)
 */
function toIsoDate(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Format objek Series sesuai rules.md §3
 */
function formatSeries(row, genres = []) {
  if (!row) return null;

  // Jika genres belum dipass tapi ada di row (misal group_concat)
  let genreList = genres;
  if (!genreList.length && row.genres_joined) {
    genreList = row.genres_joined.split(',').map((g) => g.trim()).filter(Boolean);
  } else if (!genreList.length && Array.isArray(row.genres)) {
    genreList = row.genres;
  }

  const series = {
    id: String(row.id),
    title: String(row.title || ''),
    type: row.type || 'Donghua',
    status: row.status || 'Ongoing',
    genres: genreList,
    rating: parseFloat(parseFloat(row.rating || 0).toFixed(1)),
    episode_count: parseInt(row.episode_count || 0, 10),
    latest_episode: parseInt(row.latest_episode || 0, 10),
    synopsis: row.synopsis || '',
    poster: row.poster || null,
    updated_at: toIsoDate(row.updated_at) || new Date().toISOString(),
  };

  if (row.alt_title) series.alt_title = row.alt_title;
  if (row.backdrop) series.backdrop = row.backdrop;
  if (row.accent_hue !== null && row.accent_hue !== undefined) {
    series.accent_hue = parseInt(row.accent_hue, 10);
  }
  if (row.year) series.year = parseInt(row.year, 10);

  return series;
}

/**
 * Format objek Episode sesuai rules.md §3
 */
function formatEpisode(row) {
  if (!row) return null;

  const releasedAt = toIsoDate(row.released_at);
  let isNew = false;
  if (row.released_at) {
    const diffMs = Date.now() - new Date(row.released_at).getTime();
    isNew = diffMs > 0 && diffMs < 7 * 86400 * 1000;
  }

  return {
    n: parseInt(row.n, 10),
    title: row.title || `Episode ${row.n}`,
    duration_seconds: parseInt(row.duration_seconds || 0, 10),
    released_at: releasedAt,
    thumbnail: row.thumbnail || null,
    is_new: isNew,
  };
}

/**
 * Kirim JSON Response dengan dukungan ETag, 304, dan Cache-Control
 */
function jsonResponse(res, data, status = 200, cacheControl = 'no-store') {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.setHeader('Cache-Control', cacheControl);

  const jsonStr = JSON.stringify(data, null, 2);
  const etag = `"${crypto.createHash('md5').update(jsonStr).digest('hex')}"`;
  res.setHeader('ETag', etag);

  // Cek If-None-Match untuk 304 Not Modified (§2.5)
  if (res.req && res.req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  return res.send(jsonStr);
}

/**
 * Format error seragam (§5 rules.md)
 */
function errorResponse(res, httpCode, code, message, retryAfter = null) {
  const errorObj = {
    code,
    message,
  };
  if (retryAfter !== null) {
    errorObj.retry_after = retryAfter;
    res.setHeader('Retry-After', retryAfter);
  }

  return jsonResponse(res, { error: errorObj }, httpCode, 'no-store');
}

/**
 * Cache getter (kombinasi memory cache + DB response_cache)
 */
async function getCachedResponse(key) {
  // 1. Cek memory cache
  const mem = memoryCache.get(key);
  if (mem && mem.expires_at > Date.now()) {
    return mem.data;
  }

  // 2. Cek DB cache
  try {
    const rows = await query(
      'SELECT cache_data FROM response_cache WHERE cache_key = ? AND expires_at > NOW() LIMIT 1',
      [key]
    );
    if (rows && rows.length > 0 && rows[0].cache_data) {
      const parsed = JSON.parse(rows[0].cache_data);
      memoryCache.set(key, { data: parsed, expires_at: Date.now() + 60000 });
      return parsed;
    }
  } catch (err) {
    // Abaikan jika tabel DB belum siap
  }

  return null;
}

/**
 * Cache setter
 */
async function setCachedResponse(key, data, ttlSeconds) {
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  memoryCache.set(key, { data, expires_at: expiresAtMs });

  try {
    const jsonStr = JSON.stringify(data);
    const etag = crypto.createHash('md5').update(jsonStr).digest('hex');
    await query(
      `INSERT INTO response_cache (cache_key, cache_data, etag, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
          cache_data = VALUES(cache_data),
          etag       = VALUES(etag),
          expires_at = VALUES(expires_at)`,
      [key, jsonStr, etag, ttlSeconds]
    );
  } catch (err) {
    // Abaikan jika DB bermasalah
  }
}

module.exports = {
  CACHE_HOME,
  CACHE_SERIES,
  CACHE_SCHEDULE,
  CACHE_GENRES,
  CACHE_PLAY,
  getSourceBaseUrl,
  makeAbsolute,
  slugify,
  toIsoDate,
  formatSeries,
  formatEpisode,
  jsonResponse,
  errorResponse,
  getCachedResponse,
  setCachedResponse,
};
