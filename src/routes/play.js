/**
 * ═══════════════════════════════════════════════════
 *  Route: /series/:id/episodes/:n/play (§4, §2.4)
 * ═══════════════════════════════════════════════════
 *  - Resolusi URL video pemutaran episode
 *  - Mendukung POST dan GET (untuk testing browser langsung)
 *  - Cache 15 menit, timeout upstream ketat 4 detik
 *  - Hanya mengembalikan URL, TIDAK meneruskan byte video
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const { query } = require('../db');
const {
  CACHE_PLAY,
  jsonResponse,
  errorResponse,
  toIsoDate,
  getSourceBaseUrl,
} = require('../helpers');
const { scrapeEpisodeStream, scrapeSeriesPage } = require('../scraper');

async function handlePlay(req, res, next) {
  const cacheHeader = 'private, max-age=900';
  const seriesId = req.params.id;
  const n = parseInt(req.params.n, 10);

  if (isNaN(n) || n <= 0) {
    return errorResponse(res, 400, 'bad_request', 'Nomor episode tidak valid.');
  }

  try {
    // 1. Cari data episode di database
    let ep = null;
    try {
      const epRows = await query(
        'SELECT * FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
        [seriesId, n]
      );
      if (epRows.length > 0) ep = epRows[0];
    } catch (e) {
      console.warn('[Play:epQuery]', e.message);
    }

    // Jika episode belum terdaftar di DB, coba auto-scrape detail series
    if (!ep) {
      const detailUrl = `${getSourceBaseUrl()}/${seriesId}/`;
      const scraped = await scrapeSeriesPage(detailUrl, seriesId);

      if (scraped && scraped.episodes) {
        const found = scraped.episodes.find((e) => e.n === n);
        if (found) {
          ep = found;
          // Coba ambil ID database jika tersimpan
          try {
            const epRows = await query(
              'SELECT * FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
              [seriesId, n]
            );
            if (epRows.length > 0) ep = epRows[0];
          } catch (e) {}
        }
      }
    }

    if (!ep) {
      return errorResponse(res, 404, 'not_found', 'Episode ini belum tersedia.');
    }

    // 2. Cek cache stream yang masih aktif di database
    if (ep.id) {
      try {
        const cachedStreams = await query(
          'SELECT * FROM episode_streams WHERE episode_id = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
          [ep.id]
        );

        if (cachedStreams.length > 0) {
          const c = cachedStreams[0];
          const sources = typeof c.stream_data === 'string' ? JSON.parse(c.stream_data) : c.stream_data || [];
          const subtitles = typeof c.subtitle_data === 'string' ? JSON.parse(c.subtitle_data) : c.subtitle_data || [];

          return jsonResponse(
            res,
            {
              series_id: seriesId,
              episode: n,
              provider: c.provider || 'unknown',
              sources,
              subtitles,
              expires_at: toIsoDate(c.expires_at),
              fallback_embed: c.embed_url,
            },
            200,
            cacheHeader
          );
        }
      } catch (e) {
        console.warn('[Play:cacheCheck]', e.message);
      }
    }

    // 3. Resolve dari website anichin dengan timeout ketat 4 detik (§2.4)
    const sourceUrl = ep.source_url || `${getSourceBaseUrl()}/${seriesId}-episode-${n}/`;
    const streamResult = await scrapeEpisodeStream(sourceUrl, 4000);

    if (!streamResult || !streamResult.embedUrl) {
      return errorResponse(
        res,
        503,
        'upstream_failed',
        'Sumber video tidak merespons atau sedang offline.',
        30
      );
    }

    const expiresAt = new Date(Date.now() + CACHE_PLAY * 1000);
    const expiresAtSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

    // 4. Simpan ke cache episode_streams jika DB tersedia
    if (ep.id) {
      try {
        await query(
          `INSERT INTO episode_streams
            (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
           VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
          [
            ep.id,
            streamResult.provider,
            streamResult.embedUrl,
            JSON.stringify(streamResult.sources),
            JSON.stringify(streamResult.subtitles),
            expiresAtSql,
          ]
        );
      } catch (e) {
        console.warn('[Play:saveCache]', e.message);
      }
    }

    return jsonResponse(
      res,
      {
        series_id: seriesId,
        episode: n,
        provider: streamResult.provider,
        sources: streamResult.sources,
        subtitles: streamResult.subtitles,
        expires_at: expiresAt.toISOString(),
        fallback_embed: streamResult.embedUrl,
      },
      200,
      cacheHeader
    );
  } catch (err) {
    next(err);
  }
}

router.post('/', handlePlay);
router.get('/', handlePlay);

module.exports = router;
