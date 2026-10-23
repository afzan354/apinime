/**
 * ═══════════════════════════════════════════════════
 *  Route: /admin — AnibiPlay Cloud Dashboard & Sync
 * ═══════════════════════════════════════════════════
 *  Dashboard web yang bisa diakses langsung lewat browser HP
 *  atau laptop untuk memperbarui data anime, episode, dan video
 *  streaming ke TiDB Cloud tanpa perlu menyalakan laptop lokal.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getSourceBaseUrl } = require('../helpers');
const { scrapeSeriesPage, scrapeEpisodeStream } = require('../scraper');

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
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: Sinkronkan 1 Judul Tertentu ───────────────────────────────
router.post('/api/sync-series', async (req, res) => {
  const slug = (req.body.slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!slug) {
    return res.status(400).json({ ok: false, error: 'Slug judul wajib diisi!' });
  }

  const logs = [];
  try {
    logs.push(`🔍 Mencari data untuk series: "${slug}"...`);
    const sourceUrl = `${getSourceBaseUrl()}/${slug}/`;
    const scraped = await scrapeSeriesPage(sourceUrl, slug);

    if (!scraped) {
      logs.push(`✗ Gagal mengambil halaman "${slug}" dari upstream.`);
      return res.json({ ok: false, logs });
    }

    const epCount = scraped.episodes ? scraped.episodes.length : 0;
    logs.push(`✓ Berhasil menyimpan detail "${scraped.title || slug}" dengan ${epCount} episode!`);

    // Auto-resolve video link untuk episode terbaru
    if (scraped.episodes && scraped.episodes.length > 0) {
      const latestEp = scraped.episodes[0]; // biasanya episode terbesar
      logs.push(`🎬 Mencoba resolve streaming episode terbaru (Ep ${latestEp.n})...`);
      try {
        const stream = await scrapeEpisodeStream(latestEp.source_url, 9000);
        if (stream && stream.embedUrl) {
          // Cari episode_id di database
          const epRows = await query(
            'SELECT id FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
            [slug, latestEp.n]
          );
          if (epRows.length > 0) {
            const epId = epRows[0].id;
            const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
              .toISOString().slice(0, 19).replace('T', ' ');
            await query(
              `INSERT INTO episode_streams
                (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
               VALUES (?, ?, ?, ?, ?, NOW(), ?)
               ON DUPLICATE KEY UPDATE embed_url = VALUES(embed_url), stream_data = VALUES(stream_data), expires_at = VALUES(expires_at)`,
              [epId, stream.provider, stream.embedUrl, JSON.stringify(stream.sources), JSON.stringify(stream.subtitles), expiresAt]
            );
            logs.push(`✓ Streaming Ep ${latestEp.n} tersimpan (${stream.sources.length} mirrors: ${stream.provider})!`);
          }
        } else {
          logs.push(`ℹ Video Ep ${latestEp.n} belum siap di upstream atau butuh direct browser client.`);
        }
      } catch (stErr) {
        logs.push(`⚠ Streaming Ep ${latestEp.n}: ${stErr.message}`);
      }
    }

    return res.json({ ok: true, logs });
  } catch (err) {
    logs.push(`✗ Error: ${err.message}`);
    return res.status(500).json({ ok: false, logs });
  }
});

// ─── API: Simpan Hasil Stream dari Browser HP (Client Direct) ───────
router.post('/api/save-stream', async (req, res) => {
  const { series_id, n, provider, embed_url, sources, subtitles } = req.body;
  if (!series_id || !n || !embed_url) {
    return res.status(400).json({ ok: false, error: 'Data tidak lengkap' });
  }

  try {
    const epRows = await query(
      'SELECT id FROM episodes WHERE series_id = ? AND n = ? LIMIT 1',
      [series_id, parseInt(n, 10)]
    );
    if (!epRows.length) {
      return res.status(404).json({ ok: false, error: 'Episode tidak ditemukan di database' });
    }

    const epId = epRows[0].id;
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    await query(
      `INSERT INTO episode_streams
        (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE embed_url = VALUES(embed_url), stream_data = VALUES(stream_data), expires_at = VALUES(expires_at)`,
      [
        epId,
        provider || 'unknown',
        embed_url,
        JSON.stringify(sources || []),
        JSON.stringify(subtitles || []),
        expiresAt,
      ]
    );

    return res.json({ ok: true, message: `Episode ${n} (${series_id}) berhasil disimpan dari browser!` });
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
      --success-glow: rgba(16, 185, 129, 0.25);
      --warning: #f59e0b;
      --danger: #ef4444;
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
      padding: 20px 16px 40px;
      line-height: 1.5;
    }

    .container {
      max-width: 680px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 8px 20px var(--primary-glow);
    }
    .brand-title {
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #fff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-subtitle {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--success);
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 6px 12px;
      border-radius: 9999px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 16px 14px;
      text-align: center;
      transition: transform 0.2s, border-color 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.16);
    }
    .stat-val {
      font-size: 1.6rem;
      font-weight: 800;
      color: #fff;
      font-feature-settings: "tnum";
    }
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Section Card */
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 22px;
      margin-bottom: 20px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
    }
    .card-title {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Input & Buttons */
    .input-group {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
    }
    @media (max-width: 480px) {
      .input-group { flex-direction: column; }
    }
    input[type="text"] {
      flex: 1;
      background: rgba(10, 15, 26, 0.8);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 16px;
      color: #fff;
      font-family: var(--font);
      font-size: 0.92rem;
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
      font-size: 0.92rem;
      border: none;
      border-radius: 12px;
      padding: 12px 20px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s;
      white-space: nowrap;
      box-shadow: 0 4px 14px var(--primary-glow);
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
    .btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.14);
    }
    .btn-accent {
      background: linear-gradient(135deg, var(--accent), #0891b2);
      box-shadow: 0 4px 14px var(--accent-glow);
    }

    /* Chips */
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .chip {
      font-size: 0.75rem;
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
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .clear-btn {
      background: transparent;
      box-shadow: none;
      font-size: 0.75rem;
      color: var(--text-muted);
      padding: 2px 6px;
    }
    .clear-btn:hover { color: #fff; }
    .console-box {
      background: #050811;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 14px;
      padding: 14px;
      min-height: 140px;
      max-height: 260px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 0.82rem;
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

    /* Footer */
    .footer {
      text-align: center;
      margin-top: 30px;
      font-size: 0.8rem;
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
        <span>Update Anime Tertentu (Episode & Video)</span>
      </div>
      <div class="input-group">
        <input type="text" id="series-slug" placeholder="Ketik slug (contoh: link-click-season-3)" />
        <button id="btn-sync-series" onclick="syncSeries()">
          <span>🔄</span>
          <span>Update Series</span>
        </button>
      </div>
      <div class="chips">
        <span class="chip" onclick="setSlug('link-click-season-3')">link-click-season-3</span>
        <span class="chip" onclick="setSlug('soul-land-2-the-unrivaled-tang-sect')">soul-land-2</span>
        <span class="chip" onclick="setSlug('perfect-world')">perfect-world</span>
        <span class="chip" onclick="setSlug('swallowed-star')">swallowed-star</span>
        <span class="chip" onclick="setSlug('beyond-times-gaze')">beyond-times-gaze</span>
      </div>
    </div>

    <!-- Section 2: Quick Sync Buttons -->
    <div class="card">
      <div class="card-title">
        <span>⚡</span>
        <span>Aksi Cepat Otomatis</span>
      </div>
      <div class="btn-grid">
        <button class="btn-accent" id="btn-cron" onclick="triggerCron()">
          <span>🚀</span>
          <span>Jalankan Auto-Fill Cron</span>
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

    async function loadStats() {
      try {
        const res = await fetch('/admin/api/stats');
        const data = await res.json();
        if (data.ok) {
          document.getElementById('stat-series').textContent = data.series.toLocaleString();
          document.getElementById('stat-episodes').textContent = data.episodes.toLocaleString();
          document.getElementById('stat-streams').textContent = data.streams.toLocaleString();
          log('Statistik database berhasil diperbarui.', 'success');
        }
      } catch (e) {
        log('Gagal memuat statistik: ' + e.message, 'error');
      }
    }

    async function syncSeries() {
      const input = document.getElementById('series-slug');
      const slug = input.value.trim();
      if (!slug) {
        alert('Masukkan slug anime terlebih dahulu!');
        return;
      }

      const btn = document.getElementById('btn-sync-series');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Memproses...</span>';
      log('Memulai update series "' + slug + '"...', 'info');

      try {
        const res = await fetch('/admin/api/sync-series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug }),
        });
        const data = await res.json();
        if (data.logs) {
          data.logs.forEach(l => {
            const type = l.includes('✓') ? 'success' : (l.includes('✗') ? 'error' : 'info');
            log(l, type);
          });
        }
        await loadStats();
      } catch (e) {
        log('Error update series: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span><span>Update Series</span>';
      }
    }

    async function triggerCron() {
      const btn = document.getElementById('btn-cron');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Menjalankan...</span>';
      log('Menjalankan Auto-Fill Cron di cloud...', 'info');

      try {
        const res = await fetch('/api/v1/cron/fill');
        const data = await res.json();
        if (data.log) {
          data.log.forEach(l => {
            const type = l.includes('✓') ? 'success' : (l.includes('✗') ? 'error' : 'info');
            log(l, type);
          });
        }
        log('Cron selesai dalam ' + data.elapsed_seconds + ' detik.', 'success');
        await loadStats();
      } catch (e) {
        log('Error menjalankan cron: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🚀</span><span>Jalankan Auto-Fill Cron</span>';
      }
    }

    // Auto-load stats saat pertama dibuka
    loadStats();
  </script>
</body>
</html>`);
});

module.exports = router;
