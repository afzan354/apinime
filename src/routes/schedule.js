/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /schedule (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  Jadwal tayang mingguan 7 hari (Senin–Minggu), timezone Asia/Jakarta.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
  CACHE_SCHEDULE,
  jsonResponse,
  getCachedResponse,
  setCachedResponse,
} = require('../helpers');

const DAY_ORDER = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

router.get('/', async (req, res, next) => {
  const cacheHeader = 'public, max-age=600, stale-while-revalidate=300';

  try {
    const cached = await getCachedResponse('schedule');
    if (cached) {
      return jsonResponse(res, cached, 200, cacheHeader);
    }

    const days = [];

    for (const day of DAY_ORDER) {
      let items = [];
      try {
        const rows = await query(
          `SELECT sc.series_id, sc.air_time, s.title, s.latest_episode
           FROM schedule sc
           JOIN series s ON sc.series_id = s.id
           WHERE sc.day = ?
           ORDER BY sc.air_time ASC`,
          [day]
        );

        items = rows.map((r) => ({
          series_id: r.series_id,
          episode: parseInt(r.latest_episode || 0, 10) + 1,
          air_time: (r.air_time || '10:00:00').toString().slice(0, 5),
          title: r.title,
        }));
      } catch (e) {
        console.warn(`[Schedule:day ${day}]`, e.message);
      }

      days.push({
        day,
        items,
      });
    }

    const data = {
      days,
      timezone: 'Asia/Jakarta',
    };

    await setCachedResponse('schedule', data, CACHE_SCHEDULE);
    return jsonResponse(res, data, 200, cacheHeader);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
