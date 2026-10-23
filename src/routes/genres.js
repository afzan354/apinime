/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /genres (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  Daftar seluruh genre beserta jumlah judulnya.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
  CACHE_GENRES,
  jsonResponse,
  getCachedResponse,
  setCachedResponse,
} = require('../helpers');

router.get('/', async (req, res, next) => {
  const cacheHeader = 'public, max-age=86400';

  try {
    const cached = await getCachedResponse('genres');
    if (cached) {
      return jsonResponse(res, cached, 200, cacheHeader);
    }

    let items = [];
    try {
      const rows = await query(`
        SELECT g.name, COUNT(sg.series_id) AS count
        FROM genres g
        LEFT JOIN series_genres sg ON g.id = sg.genre_id
        GROUP BY g.id, g.name
        ORDER BY g.name ASC
      `);

      items = rows.map((r) => ({
        name: r.name,
        count: parseInt(r.count || 0, 10),
      }));
    } catch (e) {
      console.warn('[Genres:query]', e.message);
    }

    const data = { items };
    await setCachedResponse('genres', data, CACHE_GENRES);
    return jsonResponse(res, data, 200, cacheHeader);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
