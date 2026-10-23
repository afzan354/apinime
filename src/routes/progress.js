/**
 * ═══════════════════════════════════════════════════
 *  Route: /me/progress (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  - GET /me/progress (Ambil riwayat tontonan user)
 *  - PUT /me/progress (Simpan posisi tontonan user)
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { jsonResponse, errorResponse, toIsoDate } = require('../helpers');

/**
 * GET /me/progress
 */
router.get('/', async (req, res, next) => {
  const token = (req.query.token || req.headers['x-user-token'] || '').trim();

  if (!token) {
    return errorResponse(res, 400, 'bad_request', 'Token pengguna diperlukan.');
  }

  try {
    let items = [];
    try {
      const rows = await query(
        `SELECT series_id, episode, position_ratio, watched_at
         FROM watch_progress
         WHERE user_token = ?
         ORDER BY watched_at DESC`,
        [token]
      );

      items = rows.map((r) => ({
        series_id: r.series_id,
        episode: parseInt(r.episode || 0, 10),
        position_ratio: parseFloat(parseFloat(r.position_ratio || 0).toFixed(4)),
        watched_at: toIsoDate(r.watched_at) || new Date().toISOString(),
      }));
    } catch (e) {
      console.warn('[Progress:get]', e.message);
    }

    return jsonResponse(res, { items }, 200, 'no-store');
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /me/progress
 */
router.put('/', async (req, res, next) => {
  const token = (req.headers['x-user-token'] || '').trim();

  if (!token) {
    return errorResponse(res, 400, 'bad_request', 'Token pengguna diperlukan (Header X-User-Token).');
  }

  const { series_id, episode, position_ratio } = req.body || {};

  if (!series_id || episode === undefined || position_ratio === undefined) {
    return errorResponse(
      res,
      400,
      'bad_request',
      'Data tidak lengkap. Butuh series_id, episode, position_ratio.'
    );
  }

  try {
    await query(
      `INSERT INTO watch_progress (user_token, series_id, episode, position_ratio)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          episode = VALUES(episode),
          position_ratio = VALUES(position_ratio),
          watched_at = NOW()`,
      [token, String(series_id), parseInt(episode, 10), parseFloat(position_ratio)]
    );

    return jsonResponse(res, { status: 'ok' }, 200, 'no-store');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
