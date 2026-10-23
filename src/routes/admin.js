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
const { query } = require('../db');
const { getSourceBaseUrl } = require('../helpers');
const { parseAndSaveSeriesHtml, parseStreamFromHtml } = require('../scraper');

// ─── API: Ambil Statistik Terkini ──────────────────────────────────
router.get('/api/stats', async (req, res) => {
  try {
    const [[r1], [r2], [r3], [r4]] = await Promise.all([
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
      ORDER BY e.released_at DESC, e.id DESC
      LIMIT ?
    `, [limit]);

    return res.json({ ok: true, items: rows });
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
  const { episode_id, series_id, n, html } = req.body;
  if (!html) {
    return res.status(400).json({ ok: false, error: 'HTML episode stream wajib dikirim!' });
  }

  try {
    const stream = parseStreamFromHtml(html);
    if (!stream || !stream.embedUrl) {
      return res.status(422).json({ ok: false, error: 'Tidak ditemukan video iframe di dalam HTML.' });
    }

    // Cari episode_id jika belum diberikan
    let targetEpId = episode_id;
    if (!targetEpId && series_id && n) {
      const epRows = await query(
        'SELECT id FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
        [series_id, parseInt(n, 10)]
      );
      if (epRows.length > 0) targetEpId = epRows[0].id;
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
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>AnibiPlay Cloud Dashboard & Sync</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --accent: #06b6d4;
      --accent-glow: rgba(6, 182, 212, 0.35);
      --success: #10b981;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --font: 'Plus Jakarta Sans', -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.12) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(6, 182, 212, 0.1) 0%, transparent 40%);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      padding: 16px 14px 40px;
      line-height: 1.5;
    }

    .container {
      max-width: 640px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-badge {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: 0 8px 20px var(--primary-glow);
    }
    .brand-title {
      font-size: 1.2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #fff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-subtitle {
      font-size: 0.74rem;
      color: var(--text-muted);
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--success);
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 5px 10px;
      border-radius: 9999px;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 14px 10px;
      text-align: center;
    }
    .stat-val {
      font-size: 1.5rem;
      font-weight: 800;
      color: #fff;
    }
    .stat-label {
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-top: 2px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Section Card */
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.25);
    }
    .card-title {
      font-size: 0.95rem;
      font-weight: 700;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Input & Buttons */
    .input-group {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    @media (max-width: 480px) {
      .input-group { flex-direction: column; }
    }
    input[type="text"] {
      flex: 1;
      background: rgba(10, 15, 26, 0.8);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 14px;
      color: #fff;
      font-family: var(--font);
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }
    button {
      background: linear-gradient(135deg, var(--primary), #4338ca);
      color: #fff;
      font-family: var(--font);
      font-weight: 600;
      font-size: 0.9rem;
      border: none;
      border-radius: 12px;
      padding: 12px 18px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s;
      white-space: nowrap;
      box-shadow: 0 4px 12px var(--primary-glow);
    }
    button:hover:not(:disabled) {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    button:active:not(:disabled) {
      transform: translateY(1px);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #e2e8f0;
      box-shadow: none;
    }
    .btn-accent {
      background: linear-gradient(135deg, var(--accent), #0891b2);
      box-shadow: 0 4px 12px var(--accent-glow);
    }

    /* Chips */
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .chip {
      font-size: 0.72rem;
      padding: 4px 10px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s;
    }
    .chip:hover {
      background: rgba(99, 102, 241, 0.15);
      color: #fff;
      border-color: var(--primary);
    }

    /* Quick Grid Buttons */
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    @media (max-width: 480px) {
      .btn-grid { grid-template-columns: 1fr; }
    }

    /* Terminal Console Log */
    .console-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .console-title {
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .clear-btn {
      background: transparent;
      box-shadow: none;
      font-size: 0.72rem;
      color: var(--text-muted);
      padding: 2px 6px;
    }
    .clear-btn:hover { color: #fff; }
    .console-box {
      background: #050811;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 12px;
      min-height: 140px;
      max-height: 280px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      line-height: 1.6;
    }
    .log-line {
      margin-bottom: 4px;
      word-break: break-all;
    }
    .log-line.info { color: #93c5fd; }
    .log-line.success { color: #86efac; }
    .log-line.warning { color: #fde047; }
    .log-line.error { color: #fca5a5; }

    .badge-client {
      font-size: 0.68rem;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid var(--primary);
      color: #a5b4fc;
      padding: 2px 8px;
      border-radius: 6px;
      margin-left: 6px;
    }

    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .footer a {
      color: var(--primary);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header">
      <div class="brand">
        <div class="logo-badge">⚡</div>
        <div>
          <h1 class="brand-title">AnibiPlay Cloud Sync</h1>
          <p class="brand-subtitle">Update TiDB Cloud Langsung dari HP / Browser</p>
        </div>
      </div>
      <div class="status-pill">
        <span class="status-dot"></span>
        <span>Online</span>
      </div>
    </header>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val" id="stat-series">-</div>
        <div class="stat-label">Series</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="stat-episodes">-</div>
        <div class="stat-label">Episodes</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="stat-streams">-</div>
        <div class="stat-label">Streams</div>
      </div>
    </div>

    <!-- Section 1: Update 1 Judul Tertentu -->
    <div class="card">
      <div class="card-title">
        <span>🎯</span>
        <span>Update 1 Anime Tertentu</span>
        <span class="badge-client">Direct Connection</span>
      </div>
      <div class="input-group">
        <input type="text" id="series-slug" placeholder="Ketik slug (contoh: spare-me-great-lord-season-3)" />
        <button id="btn-sync-series" onclick="syncSeriesClient()">
          <span>🔄</span>
          <span>Update Series</span>
        </button>
      </div>
      <div class="chips">
        <span class="chip" onclick="setSlug('spare-me-great-lord-season-3')">spare-me-great-lord-s3</span>
        <span class="chip" onclick="setSlug('swallowed-star')">swallowed-star</span>
        <span class="chip" onclick="setSlug('soul-land-2-the-unrivaled-tang-sect')">soul-land-2</span>
        <span class="chip" onclick="setSlug('perfect-world')">perfect-world</span>
        <span class="chip" onclick="setSlug('link-click-season-3')">link-click-season-3</span>
      </div>
    </div>

    <!-- Section 2: Quick Sync Buttons -->
    <div class="card">
      <div class="card-title">
        <span>⚡</span>
        <span>Aksi Cepat Streaming Video</span>
      </div>
      <div class="btn-grid">
        <button class="btn-accent" id="btn-fill-streams" onclick="fillMissingStreamsClient()">
          <span>🎬</span>
          <span>Isi 5 Link Streaming Kosong</span>
        </button>
        <button class="btn-secondary" id="btn-refresh-stats" onclick="loadStats()">
          <span>📊</span>
          <span>Segarkan Statistik</span>
        </button>
      </div>
    </div>

    <!-- Section 3: Live Output Terminal -->
    <div class="card">
      <div class="console-header">
        <span class="console-title">Live Progress Log</span>
        <button class="clear-btn" onclick="clearLogs()">Hapus Log</button>
      </div>
      <div class="console-box" id="console">
        <div class="log-line info">Siap menerima instruksi dari kamu.</div>
      </div>
    </div>

    <footer class="footer">
      <p>AnibiPlay API v1.0 • Backed by TiDB Cloud & Vercel Serverless</p>
      <p style="margin-top: 4px;"><a href="/api/v1/health" target="_blank">Health Check API</a> • <a href="/api/v1/home" target="_blank">Home API</a></p>
    </footer>
  </div>

  <script>
    let WORKER_BASE = 'https://anibli.wedussamsung6.workers.dev';

    function log(msg, type = 'info') {
      const box = document.getElementById('console');
      const div = document.createElement('div');
      div.className = 'log-line ' + type;
      div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    function clearLogs() {
      document.getElementById('console').innerHTML = '<div class="log-line info">Log dibersihkan.</div>';
    }

    function setSlug(val) {
      document.getElementById('series-slug').value = val;
    }

    // Ambil statistik awal
    async function loadStats() {
      try {
        const res = await fetch('/admin/api/stats');
        const data = await res.json();
        if (data.ok) {
          document.getElementById('stat-series').textContent = data.series.toLocaleString();
          document.getElementById('stat-episodes').textContent = data.episodes.toLocaleString();
          document.getElementById('stat-streams').textContent = data.streams.toLocaleString();
          if (data.worker) WORKER_BASE = data.worker.replace(/\\/+$/, '');
          log('Statistik database: ' + data.series + ' Series, ' + data.episodes + ' Episodes, ' + data.streams + ' Streams aktif.', 'success');
        }
      } catch (e) {
        log('Gagal memuat statistik: ' + e.message, 'error');
      }
    }

    // Helper: Tarik HTML lewat Worker menggunakan koneksi HP pengguna (100% Anti-403)
    async function fetchViaWorker(targetUrl) {
      const cleanProxy = WORKER_BASE.replace(/\\/+$/, '');
      const reqUrl = cleanProxy + '/?url=' + encodeURIComponent(targetUrl);
      const res = await fetch(reqUrl);
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      }
      return await res.text();
    }

    // Update 1 Series (Client-Assisted: bypass Cloudflare WAF lewat IP HP)
    async function syncSeriesClient() {
      const input = document.getElementById('series-slug');
      const slug = input.value.trim();
      if (!slug) {
        alert('Masukkan slug anime terlebih dahulu!');
        return;
      }

      const btn = document.getElementById('btn-sync-series');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Mengambil data...</span>';
      log('📱 Mengambil data "' + slug + '" lewat koneksi HP...', 'info');

      try {
        const targetUrl = 'https://anichin.moe/' + slug + '/';
        const html = await fetchViaWorker(targetUrl);
        log('✓ Berhasil mengambil HTML (' + Math.round(html.length / 1024) + ' KB)! Mengirim ke TiDB Cloud...', 'info');

        // Kirim HTML ke backend Vercel untuk di-parse & disimpan
        const ingestRes = await fetch('/admin/api/ingest-series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, html, url: targetUrl }),
        });
        const saved = await ingestRes.json();

        if (saved.ok) {
          log('✓ Sukses! Series "' + saved.title + '" tersimpan dengan ' + saved.episode_count + ' episode.', 'success');

          // Auto-resolve episode terbaru jika ada
          if (saved.first_episode && saved.first_episode.source_url) {
            const ep = saved.first_episode;
            log('🎬 Mengambil streaming episode terbaru (Ep ' + ep.n + ')...', 'info');
            try {
              const epHtml = await fetchViaWorker(ep.source_url);
              const stRes = await fetch('/admin/api/ingest-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ series_id: slug, n: ep.n, html: epHtml }),
              });
              const stData = await stRes.json();
              if (stData.ok) {
                log('✓ Streaming Ep ' + ep.n + ' berhasil tersimpan (' + stData.mirrors + ' mirrors: ' + stData.provider + ')!', 'success');
              }
            } catch (epErr) {
              log('⚠ Gagal ambil streaming Ep ' + ep.n + ': ' + epErr.message, 'warning');
            }
          }
        } else {
          log('✗ Gagal simpan series: ' + (saved.error || 'Unknown error'), 'error');
        }

        await loadStats();
      } catch (err) {
        log('✗ Gagal ambil halaman: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span><span>Update Series</span>';
      }
    }

    // Isi 5 Link Streaming yang Kosong Secara Berurutan
    async function fillMissingStreamsClient() {
      const btn = document.getElementById('btn-fill-streams');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Memproses...</span>';
      log('🔍 Mencari daftar episode yang belum memiliki link video...', 'info');

      try {
        const res = await fetch('/admin/api/missing-streams?limit=5');
        const data = await res.json();
        if (!data.ok || !data.items || !data.items.length) {
          log('Semua episode sudah memiliki link video aktif!', 'success');
          return;
        }

        log('Ditemukan ' + data.items.length + ' episode yang siap diisi. Memulai...', 'info');

        for (let i = 0; i < data.items.length; i++) {
          const ep = data.items[i];
          log('[' + (i + 1) + '/' + data.items.length + '] Mengambil ' + ep.series_id + ' Ep ' + ep.n + '...', 'info');
          try {
            const epHtml = await fetchViaWorker(ep.source_url);
            const stRes = await fetch('/admin/api/ingest-stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ episode_id: ep.id, series_id: ep.series_id, n: ep.n, html: epHtml }),
            });
            const stData = await stRes.json();
            if (stData.ok) {
              log('  ✓ ' + ep.series_id + ' Ep ' + ep.n + ' tersimpan (' + stData.mirrors + ' mirrors)!', 'success');
            } else {
              log('  ✗ ' + ep.series_id + ' Ep ' + ep.n + ': ' + (stData.error || 'Video tidak ditemukan'), 'warning');
            }
          } catch (e) {
            log('  ✗ ' + ep.series_id + ' Ep ' + ep.n + ' gagal: ' + e.message, 'error');
          }
        }

        log('✓ Proses pengisian 5 link streaming selesai!', 'success');
        await loadStats();
      } catch (err) {
        log('Error: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🎬</span><span>Isi 5 Link Streaming Kosong</span>';
      }
    }

    // Auto load stats saat halaman dibuka
    loadStats();
  </script>
</body>
</html>`);
});

module.exports = router;
