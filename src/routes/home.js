/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /home (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  Mengembalikan featured + fresh + trending + newest dalam 1 panggilan.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
  CACHE_HOME,
  formatSeries,
  jsonResponse,
  getCachedResponse,
  setCachedResponse,
} = require('../helpers');

router.get('/', async (req, res, next) => {
  const cacheHeader = 'public, max-age=60, stale-while-revalidate=300';

  try {
    const cached = await getCachedResponse('home');
    if (cached) {
      return jsonResponse(res, cached, 200, cacheHeader);
    }

    // Query series dengan genres (menggunakan GROUP_CONCAT agar 1 query cepat)
    const baseQuery = `
      SELECT s.*, GROUP_CONCAT(g.name SEPARATOR ',') AS genres_joined
      FROM series s
      LEFT JOIN series_genres sg ON s.id = sg.series_id
      LEFT JOIN genres g ON sg.genre_id = g.id
    `;

    // 1. Featured — rating tertinggi yang Ongoing
    let featuredRows = [];
    try {
      featuredRows = await query(
        `${baseQuery} WHERE s.status = 'Ongoing' GROUP BY s.id ORDER BY s.rating DESC, s.trending_score DESC LIMIT 1`
      );
    } catch (e) {
      console.warn('[Home:featured]', e.message);
    }

    // 2. Fresh — episode rilis ≤3 hari terakhir (fallback 12 episode terbaru)
    let freshRows = [];
    try {
      freshRows = await query(`
        SELECT s.*, e.released_at AS ep_released, e.n AS ep_n,
               GROUP_CONCAT(g.name SEPARATOR ',') AS genres_joined
        FROM series s
        JOIN episodes e ON s.id = e.series_id
        LEFT JOIN series_genres sg ON s.id = sg.series_id
        LEFT JOIN genres g ON sg.genre_id = g.id
        WHERE e.released_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        GROUP BY s.id, e.id
        ORDER BY e.released_at DESC
        LIMIT 12
      `);

      if (!freshRows.length) {
        freshRows = await query(`
          SELECT s.*, e.released_at AS ep_released, e.n AS ep_n,
                 GROUP_CONCAT(g.name SEPARATOR ',') AS genres_joined
          FROM series s
          JOIN episodes e ON s.id = e.series_id
          LEFT JOIN series_genres sg ON s.id = sg.series_id
          LEFT JOIN genres g ON sg.genre_id = g.id
          GROUP BY s.id, e.id
          ORDER BY e.created_at DESC, s.updated_at DESC
          LIMIT 12
        `);
      }
    } catch (e) {
      console.warn('[Home:fresh]', e.message);
    }

    // 3. Trending
    let trendingRows = [];
    try {
      trendingRows = await query(
        `${baseQuery} GROUP BY s.id ORDER BY s.trending_score DESC, s.rating DESC LIMIT 12`
      );
    } catch (e) {
      console.warn('[Home:trending]', e.message);
    }

    // 4. Newest
    let newestRows = [];
    try {
      newestRows = await query(
        `${baseQuery} GROUP BY s.id ORDER BY s.created_at DESC, s.updated_at DESC LIMIT 12`
      );
    } catch (e) {
      console.warn('[Home:newest]', e.message);
    }

    const featured =
      featuredRows.length > 0
        ? formatSeries(featuredRows[0])
        : trendingRows.length > 0
        ? formatSeries(trendingRows[0])
        : null;

    const fresh = freshRows.map((r) => {
      const releasedTime = r.ep_released ? new Date(r.ep_released).getTime() : Date.now();
      const diffMs = Date.now() - releasedTime;
      const diffDays = Math.floor(diffMs / (86400 * 1000));

      let label = 'hari ini';
      if (diffDays === 1) label = 'kemarin';
      else if (diffDays > 1) label = `${diffDays} hari lalu`;

      return {
        series: formatSeries(r),
        right_label: label,
      };
    });

    const trending = trendingRows.map((r) => formatSeries(r));
    const newest = newestRows.map((r) => formatSeries(r));

    const data = {
      featured,
      fresh,
      trending,
      newest,
    };

    await setCachedResponse('home', data, CACHE_HOME);
    return jsonResponse(res, data, 200, cacheHeader);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
