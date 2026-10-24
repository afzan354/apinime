/**
 * ═══════════════════════════════════════════════════
 *  Route: /series/:id/episodes/:n/play (§4, §2.4)
 * ═══════════════════════════════════════════════════
 *  - Resolusi URL video pemutaran episode
 *  - Mendukung JSON API & Web Player interaktif
 *  - Auto-resolve crowd-sourced via browser klien
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

function renderPlayerHtml(data) {
  const sources = data.sources || [];
  const primaryEmbed = data.fallback_embed || (sources[0] ? sources[0].url : '');
  const title = `${data.series_id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} - Episode ${data.episode}`;
  const isDirectFallback = Boolean(data.is_direct_fallback);
  const sourceUrl = data.direct_url || data.source_url || primaryEmbed;

  let serverButtons = '';
  sources.forEach((s, idx) => {
    const active = idx === 0 ? 'active' : '';
    serverButtons += `<button class="server-btn ${active}" onclick="switchServer('${s.url}', this)">${s.label || 'Server ' + (idx + 1)}</button>`;
  });

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${title} | AnibiPlay Player</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent: #06b6d4;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --font: 'Plus Jakarta Sans', -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 14px 12px 30px;
    }
    .player-wrap {
      width: 100%;
      max-width: 860px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .title {
      font-size: 1.05rem;
      font-weight: 700;
      color: #fff;
    }
    .badge {
      font-size: 0.72rem;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid var(--primary);
      color: #a5b4fc;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .video-box {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #000;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid var(--card-border);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .video-box iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    .servers-box {
      margin-top: 14px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px;
    }
    .servers-title {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .servers-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .server-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      color: #e2e8f0;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .server-btn:hover {
      background: rgba(99, 102, 241, 0.2);
      border-color: var(--primary);
      color: #fff;
    }
    .server-btn.active {
      background: linear-gradient(135deg, var(--primary), #4338ca);
      border-color: var(--primary);
      color: #fff;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }
    .status-alert {
      margin-top: 10px;
      font-size: 0.78rem;
      color: #fde047;
      display: flex;
      align-items: center;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="player-wrap">
    <div class="header">
      <h1 class="title">${title}</h1>
      <span class="badge">Episode ${data.episode}</span>
    </div>

    <div class="video-box">
      <iframe id="main-iframe" src="${primaryEmbed}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
    </div>

    <div class="servers-box">
      <div class="servers-title">Pilih Server Mirror Video:</div>
      <div class="servers-list" id="servers-list">
        ${serverButtons}
      </div>
      ${isDirectFallback ? `<div class="status-alert" id="status-alert">⚡ Menyinkronkan server video lengkap di latar belakang via koneksi Anda...</div>` : ''}
    </div>
  </div>

  <script>
    function switchServer(url, btn) {
      document.getElementById('main-iframe').src = url;
      document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    }

    ${isDirectFallback ? `
    // Background Auto-Resolver via user connection (Anti-403)
    (async () => {
      try {
        const targetUrl = '${sourceUrl}';
        const proxy = 'https://anibli.wedussamsung6.workers.dev/?url=' + encodeURIComponent(targetUrl);
        const res = await fetch(proxy);
        if (!res.ok) return;
        const html = await res.text();
        const ingestRes = await fetch('/admin/api/ingest-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ series_id: '${data.series_id}', n: ${data.episode}, html: html, source_url: targetUrl })
        });
        const saved = await ingestRes.json();
        if (saved && saved.ok) {
          const alertEl = document.getElementById('status-alert');
          if (alertEl) alertEl.innerHTML = '✓ ' + (saved.mirrors || 0) + ' server mirror berhasil di-unlock dan disimpan!';
          setTimeout(() => { window.location.reload(); }, 1200);
        }
      } catch (err) {
        console.warn('Auto resolve background error:', err);
      }
    })();
    ` : ''}
  </script>
</body>
</html>`;
}

function sendPlayResponse(req, res, playData, cacheHeader) {
  const wantsHtml = req.query.format === 'html' || 
    (req.baseUrl && req.baseUrl.includes('/player')) ||
    (req.path && req.path.includes('/player')) ||
    (req.accepts && req.accepts('html') && !req.accepts('json') && !req.xhr);

  if (wantsHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderPlayerHtml(playData));
  }

  return jsonResponse(res, playData, 200, cacheHeader);
}

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
    let actualSeriesId = seriesId;
    try {
      let epRows = await query(
        'SELECT * FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
        [actualSeriesId, n]
      );
      if (epRows.length > 0) {
        ep = epRows[0];
      } else {
        // Toleransi slug jika ada gabungan judul
        const matched = await query(
          'SELECT id FROM series WHERE ? LIKE CONCAT("%", id, "%") ORDER BY LENGTH(id) DESC LIMIT 1',
          [seriesId]
        );
        if (matched.length > 0) {
          actualSeriesId = matched[0].id;
          epRows = await query(
            'SELECT * FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
            [actualSeriesId, n]
          );
          if (epRows.length > 0) ep = epRows[0];
        }
      }
    } catch (e) {
      console.warn('[Play:epQuery]', e.message);
    }

    // Jika episode belum terdaftar di DB, coba auto-scrape detail series
    if (!ep) {
      const detailUrl = `${getSourceBaseUrl()}/${actualSeriesId}/`;
      const scraped = await scrapeSeriesPage(detailUrl, actualSeriesId);

      if (scraped && scraped.episodes) {
        const found = scraped.episodes.find((e) => e.n === n);
        if (found) {
          ep = found;
          try {
            const epRows = await query(
              'SELECT * FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
              [actualSeriesId, n]
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

          return sendPlayResponse(
            req,
            res,
            {
              series_id: actualSeriesId,
              episode: n,
              provider: c.provider || 'unknown',
              sources,
              subtitles,
              expires_at: toIsoDate(c.expires_at),
              fallback_embed: c.embed_url,
            },
            cacheHeader
          );
        }
      } catch (e) {
        console.warn('[Play:cacheCheck]', e.message);
      }
    }

    // 3. Resolve dari website anichin dengan timeout 8 detik
    const sourceUrl = ep.source_url || `${getSourceBaseUrl()}/${actualSeriesId}-episode-${n}/`;
    const streamResult = await scrapeEpisodeStream(sourceUrl, 8000);

    if (!streamResult || !streamResult.embedUrl) {
      // Fallback: Jika upstream scraper terhalang Cloudflare 403 di serverless Vercel,
      // jangan gagal 503. Kembalikan URL episode langsung agar aplikasi atau browser pengguna
      // (yang IP-nya tidak diblokir Cloudflare) dapat langsung memutar video secara instan.
      return sendPlayResponse(
        req,
        res,
        {
          series_id: actualSeriesId,
          episode: n,
          provider: 'Anichin Direct',
          sources: [
            {
              label: 'Direct Web Player',
              url: sourceUrl,
              type: 'embed',
              height: 720,
            },
          ],
          subtitles: [
            { lang: 'id', label: 'Indonesia', url: '', default: true },
          ],
          expires_at: new Date(Date.now() + CACHE_PLAY * 1000).toISOString(),
          fallback_embed: sourceUrl,
          direct_url: sourceUrl,
          is_direct_fallback: true,
          client_resolver: {
            source_url: sourceUrl,
            series_id: actualSeriesId,
            episode: n,
            ingest_endpoint: '/admin/api/ingest-stream',
            worker_proxy: 'https://anibli.wedussamsung6.workers.dev',
          },
        },
        cacheHeader
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

    return sendPlayResponse(
      req,
      res,
      {
        series_id: actualSeriesId,
        episode: n,
        provider: streamResult.provider,
        sources: streamResult.sources,
        subtitles: streamResult.subtitles,
        expires_at: expiresAt.toISOString(),
        fallback_embed: streamResult.embedUrl,
      },
      cacheHeader
    );
  } catch (err) {
    next(err);
  }
}

router.post('/', handlePlay);
router.get('/', handlePlay);

module.exports = router;

