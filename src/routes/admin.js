/**
 * ═══════════════════════════════════════════════════
 *  Route: /admin — AnibiPlay Cloud Dashboard & Sync
 * ═══════════════════════════════════════════════════
 *  Dashboard web yang bisa diakses langsung lewat browser HP
 *  atau laptop untuk memperbarui data anime, episode, dan video
 *  streaming ke TiDB Cloud secara 100% lancar tanpa blokir Cloudflare.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { getSourceBaseUrl } = require('../helpers');
const { parseAndSaveSeriesHtml, parseStreamFromHtml } = require('../scraper');

// Body parser khusus route admin hingga 10MB
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Cache Dashboard HTML ──────────────────────────────────────────
let adminHtmlCache = null;
function getDashboardHtml() {
  if (!adminHtmlCache) {
    try {
      adminHtmlCache = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    } catch (err) {
      console.error('[Admin] Gagal membaca admin.html:', err.message);
    }
  }
  return adminHtmlCache;
}

// ─── API: Diagnostic Outbound Fetch ───────────────────────────────
router.get('/api/test-fetch', async (req, res) => {
  const testUrl = req.query.url || 'https://anichin.moe/swallowed-star-episode-201-subtitle-indonesia/';
  const isDirect = req.query.direct === '1';
  const proxyUrl = process.env.PROXY_URL || process.env.CLOUDFLARE_WORKER_URL;
  const cleanProxy = proxyUrl ? proxyUrl.replace(/\/+$/, '') : null;
  const target = (!isDirect && cleanProxy) ? `${cleanProxy}/?url=${encodeURIComponent(testUrl)}` : testUrl;

  try {
    const axios = require('axios');
    const start = Date.now();
    const resp = await axios.get(target, {
      timeout: 9000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      validateStatus: () => true,
    });
    return res.json({
      target,
      status: resp.status,
      durationMs: Date.now() - start,
      dataLength: (resp.data || '').length,
      headers: resp.headers,
      snippet: String(resp.data || '').slice(0, 400),
    });
  } catch (err) {
    return res.json({
      target,
      error: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: String(err.response?.data || '').slice(0, 400),
    });
  }
});

// ─── API: Ambil Statistik Terkini ──────────────────────────────────
router.get('/api/stats', async (req, res) => {
  try {
    const [[r1], [r2], [r3], r4] = await Promise.all([
      query('SELECT COUNT(*) AS total FROM series'),
      query('SELECT COUNT(*) AS total FROM episodes'),
      query('SELECT COUNT(*) AS total FROM episode_streams WHERE expires_at > NOW()'),
      query('SELECT id, title, latest_episode, updated_at FROM series ORDER BY updated_at DESC LIMIT 5'),
    ]);

    return res.json({
      ok: true,
      series: r1 ? r1.total : 0,
      episodes: r2 ? r2.total : 0,
      streams: r3 ? r3.total : 0,
      recent: r4 || [],
      upstream: getSourceBaseUrl(),
      worker: process.env.PROXY_URL || 'https://anibli.wedussamsung6.workers.dev',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: Ambil Daftar Episode yang Belum Punya Link Streaming ──────
router.get('/api/missing-streams', async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || 5, 10)));
  try {
    const rows = await query(`
      SELECT e.id, e.series_id, e.n, e.source_url
      FROM episodes e
      LEFT JOIN episode_streams es ON e.id = es.episode_id AND es.expires_at > NOW()
      WHERE es.id IS NULL AND e.source_url IS NOT NULL AND e.source_url != ''
      ORDER BY e.id DESC
      LIMIT ${limit}
    `);

    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: Ingest Halaman Series (Dikirim oleh Browser) ──────────────
router.post('/api/ingest-series', async (req, res) => {
  const { slug, html, url } = req.body;
  if (!slug || !html) {
    return res.status(400).json({ ok: false, error: 'Slug dan HTML wajib dikirim!' });
  }

  try {
    const saved = await parseAndSaveSeriesHtml(html, slug, url);
    if (!saved) {
      return res.status(422).json({ ok: false, error: 'Gagal mem-parse struktur HTML.' });
    }

    return res.json({
      ok: true,
      title: saved.title,
      episode_count: saved.episode_count,
      latest_episode: saved.latest_episode,
      first_episode: saved.episodes && saved.episodes.length > 0 ? saved.episodes[0] : null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: Ingest Halaman Episode Stream (Dikirim oleh Browser) ──────
router.post('/api/ingest-stream', async (req, res) => {
  const { episode_id, series_id, n, html, source_url } = req.body;
  if (!html) {
    return res.status(400).json({ ok: false, error: 'HTML episode stream wajib dikirim!' });
  }

  try {
    const stream = parseStreamFromHtml(html);
    if (!stream || !stream.embedUrl) {
      return res.status(422).json({ ok: false, error: 'Tidak ditemukan video iframe di dalam HTML.' });
    }

    let targetEpId = episode_id;

    // Jika episode_id belum ada, cari berdasarkan series_id dan nomor episode
    if (!targetEpId && series_id && n) {
      const epRows = await query(
        'SELECT id FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
        [series_id, parseInt(n, 10)]
      );
      if (epRows.length > 0) targetEpId = epRows[0].id;
    }

    // Jika belum ada di tabel episodes, insert episode baru
    if (!targetEpId && series_id && n) {
      // Pastikan series ada di tabel series terlebih dahulu (mencegah pelanggaran foreign key)
      try {
        const titleStub = String(series_id).replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        await query(
          `INSERT INTO series (id, title, status, episode_count, latest_episode, updated_at)
           VALUES (?, ?, 'Ongoing', ?, ?, NOW())
           ON DUPLICATE KEY UPDATE latest_episode = GREATEST(latest_episode, VALUES(latest_episode)), updated_at = NOW()`,
          [series_id, titleStub, parseInt(n, 10), parseInt(n, 10)]
        );
      } catch (sErr) {
        // Abaikan jika sudah ada
      }

      try {
        const ins = await query(
          `INSERT INTO episodes (series_id, n, title, source_url)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE source_url = COALESCE(VALUES(source_url), source_url)`,
          [series_id, parseInt(n, 10), `Episode ${n}`, source_url || '']
        );
        targetEpId = ins.insertId;
      } catch (insErr) {
        // fallback query lagi
        const epRows2 = await query(
          'SELECT id FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
          [series_id, parseInt(n, 10)]
        );
        if (epRows2.length > 0) targetEpId = epRows2[0].id;
      }
    }

    if (targetEpId) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      await query(
        `INSERT INTO episode_streams
          (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, NOW(), ?)
         ON DUPLICATE KEY UPDATE embed_url = VALUES(embed_url), stream_data = VALUES(stream_data), expires_at = VALUES(expires_at)`,
        [
          targetEpId,
          stream.provider,
          stream.embedUrl,
          JSON.stringify(stream.sources),
          JSON.stringify(stream.subtitles),
          expiresAt,
        ]
      );
    }

    return res.json({
      ok: true,
      provider: stream.provider,
      embedUrl: stream.embedUrl,
      mirrors: stream.sources ? stream.sources.length : 0,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Halaman Utama Dashboard (Glassmorphic Mobile-First Web UI) ────
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const html = getDashboardHtml();
  if (html) {
    return res.send(html);
  }
  return res.status(500).send('<h1>500 - Gagal memuat dashboard admin (file admin.html tidak ditemukan).</h1>');
});

module.exports = router;

