/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /cron/fill — Otomatis Isi Episode Kosong
 * ═══════════════════════════════════════════════════
 *
 *  Endpoint ini dipanggil otomatis oleh Vercel Cron Job
 *  setiap hari untuk melengkapi data episode dan link streaming
 *  yang belum terisi di database. 100% berjalan di cloud,
 *  tidak perlu laptop lokal.
 *
 *  Bisa juga dipanggil manual:
 *    GET /api/v1/cron/fill
 *    GET /api/v1/cron/fill?secret=YOUR_SECRET
 *
 *  Memerlukan PROXY_URL di Vercel env agar bisa
 *  melewati proteksi Cloudflare di anichin.moe.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getSourceBaseUrl } = require('../helpers');
const { scrapeSeriesPage, scrapeEpisodeStream } = require('../scraper');

/**
 * GET /cron/fill — Cron job utama
 *
 * Flow:
 *  1. Cari semua series yang belum punya episode (episode_count = 0 atau belum ada di tabel episodes)
 *  2. Scrape detail + episode lewat Cloudflare Worker Proxy
 *  3. Cari episode yang belum punya link streaming
 *  4. Scrape link streaming lewat Cloudflare Worker Proxy
 *  5. Return laporan JSON
 */
router.get('/fill', async (req, res) => {
  const startTime = Date.now();

  // Optional: proteksi dengan CRON_SECRET
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    const querySecret = req.query.secret;
    const bearerMatch = authHeader ? authHeader.replace('Bearer ', '') : '';
    if (bearerMatch !== cronSecret && querySecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const proxyUrl = process.env.PROXY_URL || process.env.CLOUDFLARE_WORKER_URL;
  if (!proxyUrl) {
    return res.status(500).json({
      error: 'PROXY_URL belum disetel di Vercel Environment Variables',
      hint: 'Tambahkan PROXY_URL=https://anichin-proxy.xxx.workers.dev di Vercel Settings > Environment Variables',
    });
  }

  const log = [];
  let filledEpisodes = 0;
  let filledStreams = 0;

  try {
    // ═══ FASE 1: Isi episode yang kosong ═══
    const emptySeries = await query(`
      SELECT s.id, s.title, s.source_url
      FROM series s
      LEFT JOIN episodes e ON s.id = e.series_id
      GROUP BY s.id
      HAVING COUNT(e.id) = 0
      ORDER BY s.updated_at DESC
      LIMIT 20
    `);

    log.push(`📋 Fase 1: Ditemukan ${emptySeries.length} series tanpa episode`);

    for (const s of emptySeries) {
      try {
        const detailUrl = s.source_url || `${getSourceBaseUrl()}/${s.id}/`;
        const scraped = await scrapeSeriesPage(detailUrl, s.id);
        const count = scraped && scraped.episodes ? scraped.episodes.length : 0;
        filledEpisodes += count;
        log.push(`  ✓ ${s.id}: ${count} episode`);
      } catch (err) {
        log.push(`  ✗ ${s.id}: ${err.message}`);
      }

      // Vercel serverless max ~60 detik, jaga agar tidak timeout
      if (Date.now() - startTime > 50000) {
        log.push('⚠ Timeout guard: berhenti di fase 1, lanjut di cron berikutnya');
        break;
      }
    }

    // ═══ FASE 2: Isi link streaming yang kosong ═══
    if (Date.now() - startTime < 45000) {
      const episodesToResolve = await query(`
        SELECT e.id, e.series_id, e.n, e.source_url
        FROM episodes e
        LEFT JOIN episode_streams es ON e.id = es.episode_id AND es.expires_at > NOW()
        WHERE es.id IS NULL AND e.source_url IS NOT NULL AND e.source_url != ''
        ORDER BY e.released_at DESC
        LIMIT 10
      `);

      log.push(`🎬 Fase 2: Ditemukan ${episodesToResolve.length} episode tanpa link streaming`);

      for (const ep of episodesToResolve) {
        try {
          const s = await scrapeEpisodeStream(ep.source_url, 8000);
          if (s && s.embedUrl) {
            const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
              .toISOString().slice(0, 19).replace('T', ' ');
            await query(
              `INSERT INTO episode_streams (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
               VALUES (?, ?, ?, ?, ?, NOW(), ?)
               ON DUPLICATE KEY UPDATE embed_url = VALUES(embed_url), stream_data = VALUES(stream_data), expires_at = VALUES(expires_at)`,
              [ep.id, s.provider, s.embedUrl, JSON.stringify(s.sources), JSON.stringify(s.subtitles), expiresAt]
            );
            filledStreams++;
            log.push(`  ✓ ${ep.series_id} Ep ${ep.n}: ${s.sources.length} mirrors`);
          } else {
            log.push(`  ✗ ${ep.series_id} Ep ${ep.n}: tidak ditemukan`);
          }
        } catch (err) {
          log.push(`  ✗ ${ep.series_id} Ep ${ep.n}: ${err.message}`);
        }

        if (Date.now() - startTime > 55000) {
          log.push('⚠ Timeout guard: berhenti di fase 2');
          break;
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return res.status(200).json({
      ok: true,
      filled_episodes: filledEpisodes,
      filled_streams: filledStreams,
      elapsed_seconds: parseFloat(elapsed),
      log,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      log,
    });
  }
});

/**
 * GET /cron/stats — Lihat statistik database
 */
router.get('/stats', async (req, res) => {
  try {
    const [totalSeries] = await query('SELECT COUNT(*) as c FROM series');
    const [totalEpisodes] = await query('SELECT COUNT(*) as c FROM episodes');
    const [totalStreams] = await query('SELECT COUNT(*) as c FROM episode_streams WHERE expires_at > NOW()');
    const [emptySeries] = await query(`
      SELECT COUNT(DISTINCT s.id) as c FROM series s
      LEFT JOIN episodes e ON s.id = e.series_id
      GROUP BY s.id HAVING COUNT(e.id) = 0
    `);
    const [missingStreams] = await query(`
      SELECT COUNT(*) as c FROM episodes e
      LEFT JOIN episode_streams es ON e.id = es.episode_id AND es.expires_at > NOW()
      WHERE es.id IS NULL AND e.source_url IS NOT NULL AND e.source_url != ''
    `);

    return res.status(200).json({
      total_series: totalSeries.c,
      total_episodes: totalEpisodes.c,
      total_active_streams: totalStreams.c,
      series_without_episodes: emptySeries ? emptySeries.c : 0,
      episodes_without_streams: missingStreams.c,
      proxy_configured: !!(process.env.PROXY_URL || process.env.CLOUDFLARE_WORKER_URL),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
