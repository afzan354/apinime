/**
 * ═══════════════════════════════════════════════════
 *  AnibiPlay API v1.0 — Vercel Serverless & Node.js
 * ═══════════════════════════════════════════════════
 *
 *  Basis URL: /api/v1
 *  Spesifikasi: rules.md v1.0
 *
 *  Entry point untuk:
 *  1. Vercel Serverless Function (export app)
 *  2. Local development (node api/index.js)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { errorResponse } = require('../src/helpers');

// Import Route Handlers
const homeRoute = require('../src/routes/home');
const seriesRoute = require('../src/routes/series');
const playRoute = require('../src/routes/play');
const scheduleRoute = require('../src/routes/schedule');
const searchRoute = require('../src/routes/search');
const genresRoute = require('../src/routes/genres');
const progressRoute = require('../src/routes/progress');
const healthRoute = require('../src/routes/health');
const cronRoute = require('../src/routes/cron');
const adminRoute = require('../src/routes/admin');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────

// CORS: Izinkan akses dari mana saja termasuk Mobile APK & Web
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-User-Token', 'If-None-Match'],
    maxAge: 86400,
  })
);

// Body Parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health / Root Route ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'AnibiPlay API',
    version: '1.0.0',
    status: 'online',
    platform: 'Vercel Serverless / Node.js',
    documentation: '/api/v1/health',
    endpoints: {
      home: 'GET /api/v1/home',
      series: 'GET /api/v1/series',
      series_detail: 'GET /api/v1/series/:id',
      episodes: 'GET /api/v1/series/:id/episodes',
      play: 'POST|GET /api/v1/series/:id/episodes/:n/play',
      schedule: 'GET /api/v1/schedule',
      search: 'GET /api/v1/search?q=:keyword',
      genres: 'GET /api/v1/genres',
      progress: 'GET|PUT /api/v1/me/progress',
      health: 'GET /api/v1/health',
    },
  });
});

// ─── Mount API Routes ─────────────────────────────────────────────
// Mendukung prefix /api/v1, /v1, dan langsung tanpa prefix agar fleksibel
const apiRouter = express.Router();

apiRouter.use('/home', homeRoute);
apiRouter.use('/series/:id/episodes/:n/play', playRoute);
apiRouter.use('/series', seriesRoute);
apiRouter.use('/schedule', scheduleRoute);
apiRouter.use('/search', searchRoute);
apiRouter.use('/genres', genresRoute);
apiRouter.use('/me/progress', progressRoute);
apiRouter.use('/health', healthRoute);
apiRouter.use('/cron', cronRoute);
apiRouter.use('/admin', adminRoute);

// Pasang router ke beberapa alias prefix
app.use('/api/v1', apiRouter);
app.use('/v1', apiRouter);
app.use('/api', apiRouter);

// Pasang juga langsung di root path (contoh: GET /home, GET /admin)
app.use('/admin', adminRoute);
app.use('/', apiRouter);

// ─── 404 Handler (§5 rules.md) ────────────────────────────────────
app.use((req, res) => {
  return errorResponse(res, 404, 'not_found', 'Endpoint tidak ditemukan.');
});

// ─── Global Error Handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[API Error]', err);
  return errorResponse(res, 500, 'internal', 'Terjadi kesalahan pada server.');
});

// ─── Start Server (Local Mode) ────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ╔════════════════════════════════════════════╗`);
    console.log(`  ║   AnibiPlay API v1.0 (Vercel / Node.js)    ║`);
    console.log(`  ╚════════════════════════════════════════════╝`);
    console.log(`  Server aktif di : http://localhost:${PORT}`);
    console.log(`  Health check    : http://localhost:${PORT}/api/v1/health`);
    console.log(`  Endpoint Home   : http://localhost:${PORT}/api/v1/home\n`);
  });
}

// Export untuk Vercel Serverless
module.exports = app;
