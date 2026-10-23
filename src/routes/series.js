/**
 * ═══════════════════════════════════════════════════
 *  Route: /series (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  - GET /series                (Katalog dengan filter & pagination)
 *  - GET /series/:id            (Detail series + 5 episode preview)
 *  - GET /series/:id/episodes   (Daftar semua episode)
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
  formatSeries,
  formatEpisode,
  jsonResponse,
  errorResponse,
  makeAbsolute,
  getSourceBaseUrl,
} = require('../helpers');
const { scrapeSeriesPage } = require('../scraper');

const API_DEFAULT_LIMIT = 24;
const API_MAX_LIMIT = 48;

/**
 * GET /series — Katalog
 */
router.get('/', async (req, res, next) => {
  const cacheHeader = 'public, max-age=60, stale-while-revalidate=300';

  try {
    const genre = (req.query.genre || '').trim();
    const status = (req.query.status || '').trim();
    const type = (req.query.type || '').trim();
    let sort = (req.query.sort || 'trending').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(
      API_MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit || String(API_DEFAULT_LIMIT), 10))
    );
    const offset = (page - 1) * limit;

    const allowedSort = ['trending', 'rating', 'newest', 'title'];
    if (!allowedSort.includes(sort)) sort = 'trending';

    const orderMap = {
      trending: 's.trending_score DESC',
      rating: 's.rating DESC',
      newest: 's.updated_at DESC',
      title: 's.title ASC',
    };

    const where = [];
    const params = [];

    if (status && ['Ongoing', 'Tamat'].includes(status)) {
      where.push('s.status = ?');
      params.push(status);
    }

    if (type && ['Donghua', 'Anime', 'Film'].includes(type)) {
      where.push('s.type = ?');
      params.push(type);
    }

    let joinGenre = '';
    if (genre) {
      joinGenre =
        'JOIN series_genres sg ON s.id = sg.series_id JOIN genres g ON sg.genre_id = g.id';
      where.push('g.name = ?');
      params.push(genre);
    }

    const whereSQL = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSQL = orderMap[sort];

    // Hitung Total
    let total = 0;
    try {
      const countRows = await query(
        `SELECT COUNT(DISTINCT s.id) AS total FROM series s ${joinGenre} ${whereSQL}`,
        params
      );
      if (countRows.length > 0) total = parseInt(countRows[0].total || 0, 10);
    } catch (e) {
      console.warn('[Series:count]', e.message);
    }

    // Ambil Data
    let items = [];
    try {
      const sql = `
        SELECT s.*, GROUP_CONCAT(DISTINCT g.name SEPARATOR ',') AS genres_joined
        FROM series s
        LEFT JOIN series_genres sg ON s.id = sg.series_id
        LEFT JOIN genres g ON sg.genre_id = g.id
        ${whereSQL}
        GROUP BY s.id
        ORDER BY ${orderSQL}
        LIMIT ${limit} OFFSET ${offset}
      `;
      const rows = await query(sql, params);
      items = rows.map((r) => formatSeries(r));
    } catch (e) {
      console.warn('[Series:items]', e.message);
    }

    return jsonResponse(
      res,
      {
        items,
        page,
        limit,
        total,
        has_more: page * limit < total,
      },
      200,
      cacheHeader
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /series/:id — Detail + 5 episode terbaru
 */
router.get('/:id', async (req, res, next) => {
  const cacheHeader = 'public, max-age=300, stale-while-revalidate=600';
  const id = req.params.id;

  try {
    let row = null;
    try {
      const rows = await query(
        `SELECT s.*, GROUP_CONCAT(DISTINCT g.name SEPARATOR ',') AS genres_joined
         FROM series s
         LEFT JOIN series_genres sg ON s.id = sg.series_id
         LEFT JOIN genres g ON sg.genre_id = g.id
         WHERE s.id = ?
         GROUP BY s.id
         LIMIT 1`,
        [id]
      );
      if (rows.length > 0) row = rows[0];
    } catch (e) {
      console.warn('[SeriesDetail:query]', e.message);
    }

    // Auto-scrape on-demand jika series belum ada di DB atau belum punya episode/sinopsis
    const isMissingDetails = !row || !row.synopsis || parseInt(row.episode_count || 0, 10) === 0;

    if (isMissingDetails) {
      const sourceUrl = row && row.source_url ? row.source_url : `${getSourceBaseUrl()}/${id}/`;
      const scraped = await scrapeSeriesPage(sourceUrl, id);

      if (scraped) {
        // Ambil data terbaru
        try {
          const freshRows = await query(
            `SELECT s.*, GROUP_CONCAT(DISTINCT g.name SEPARATOR ',') AS genres_joined
             FROM series s
             LEFT JOIN series_genres sg ON s.id = sg.series_id
             LEFT JOIN genres g ON sg.genre_id = g.id
             WHERE s.id = ?
             GROUP BY s.id
             LIMIT 1`,
            [id]
          );
          if (freshRows.length > 0) row = freshRows[0];
        } catch (e) {
          // Fallback gunakan object scraped langsung
          row = scraped;
        }
      }
    }

    if (!row) {
      return errorResponse(res, 404, 'not_found', 'Judul tidak ditemukan.');
    }

    const seriesData = formatSeries(row);

    // Ambil 5 episode preview terbaru
    let epPreview = [];
    try {
      const epRows = await query(
        'SELECT * FROM episodes WHERE series_id = ? ORDER BY n DESC LIMIT 5',
        [id]
      );
      epPreview = epRows.map((e) => formatEpisode(e));
    } catch (e) {
      if (row.episodes) {
        epPreview = row.episodes.slice(0, 5).map((e) => formatEpisode(e));
      }
    }

    seriesData.episodes_preview = epPreview;
    return jsonResponse(res, seriesData, 200, cacheHeader);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /series/:id/episodes — Daftar semua episode
 */
router.get('/:id/episodes', async (req, res, next) => {
  const cacheHeader = 'public, max-age=300, stale-while-revalidate=600';
  const id = req.params.id;

  try {
    let episodes = [];
    try {
      const rows = await query(
        'SELECT * FROM episodes WHERE series_id = ? ORDER BY n DESC',
        [id]
      );
      episodes = rows.map((e) => formatEpisode(e));
    } catch (e) {
      console.warn('[Episodes:query]', e.message);
    }

    // Jika episode kosong, coba scrape on-demand
    if (!episodes.length) {
      const detailUrl = `${getSourceBaseUrl()}/${id}/`;
      const scraped = await scrapeSeriesPage(detailUrl, id);

      if (scraped && scraped.episodes) {
        episodes = scraped.episodes.map((e) => formatEpisode(e));
      }
    }

    if (!episodes.length) {
      // Cek apakah series ada
      try {
        const sRows = await query('SELECT id FROM series WHERE id = ? LIMIT 1', [id]);
        if (!sRows.length) {
          return errorResponse(res, 404, 'not_found', 'Judul tidak ditemukan.');
        }
      } catch (e) {}
    }

    return jsonResponse(
      res,
      {
        series_id: id,
        items: episodes,
      },
      200,
      cacheHeader
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
