/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /search?q= (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  - Pencarian judul & genre
 *  - Minimal 2 karakter
 *  - Mengembalikan 200 dengan items: [] jika kosong
 *  - Cache-Control: no-store
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { formatSeries, jsonResponse, errorResponse } = require('../helpers');

const API_DEFAULT_LIMIT = 24;
const API_MAX_LIMIT = 48;

router.get('/', async (req, res, next) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(
    API_MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit || String(API_DEFAULT_LIMIT), 10))
  );

  if (q.length < 2) {
    return errorResponse(res, 400, 'bad_request', 'Kata kunci pencarian minimal 2 huruf.');
  }

  try {
    const likePattern = `%${q}%`;
    let items = [];

    try {
      const sql = `
        SELECT DISTINCT s.*,
               GROUP_CONCAT(DISTINCT g.name SEPARATOR ',') AS genres_joined
        FROM series s
        LEFT JOIN series_genres sg ON s.id = sg.series_id
        LEFT JOIN genres g ON sg.genre_id = g.id
        WHERE s.title LIKE ?
           OR s.alt_title LIKE ?
           OR s.synopsis LIKE ?
           OR g.name LIKE ?
        GROUP BY s.id
        ORDER BY s.trending_score DESC, s.rating DESC
        LIMIT ${limit}
      `;

      const rows = await query(sql, [likePattern, likePattern, likePattern, likePattern]);
      items = rows.map((r) => formatSeries(r));
    } catch (e) {
      console.warn('[Search:query]', e.message);
    }

    return jsonResponse(
      res,
      {
        query: q,
        items,
      },
      200,
      'no-store'
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
