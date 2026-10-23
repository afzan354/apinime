/**
 * ═══════════════════════════════════════════════════
 *  Route: GET /health (§4 rules.md)
 * ═══════════════════════════════════════════════════
 *  Pemeriksaan kesehatan API, koneksi database, dan upstream anichin.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { checkDb } = require('../db');
const { jsonResponse, getSourceBaseUrl } = require('../helpers');

router.get('/', async (req, res) => {
  const t0 = Date.now();
  let upstreamOk = false;
  let latencyMs = 0;

  try {
    const upstreamUrl = getSourceBaseUrl();
    const upRes = await axios.head(upstreamUrl, {
      timeout: 5000,
      headers: {
        'User-Agent':
          process.env.SCRAPER_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      validateStatus: () => true, // Terima status apa pun untuk ukur latensi
    });

    latencyMs = Date.now() - t0;
    upstreamOk = upRes.status > 0 && upRes.status < 500;
  } catch (err) {
    latencyMs = Date.now() - t0;
    upstreamOk = false;
  }

  let debugTest = null;
  if (req.query.test_url) {
    try {
      const target = String(req.query.test_url);
      const testRes = await axios.get(target, {
        timeout: 8000,
        headers: {
          'User-Agent':
            process.env.SCRAPER_USER_AGENT ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        validateStatus: () => true,
      });
      debugTest = {
        url: target,
        status: testRes.status,
        hasIframes: testRes.data.includes('<iframe'),
        dataLength: testRes.data ? testRes.data.length : 0,
        server: testRes.headers['server'],
        title: (testRes.data.match(/<title>(.*?)<\/title>/i) || [])[1],
      };
    } catch (testErr) {
      debugTest = { error: testErr.message };
    }
  }

  const proxyConfigured = !!(process.env.PROXY_URL || process.env.CLOUDFLARE_WORKER_URL);

  return jsonResponse(
    res,
    {
      ok: dbOk,
      proxy_configured: proxyConfigured,
      upstreams: [
        {
          name: 'anichin',
          ok: upstreamOk,
          latency_ms: latencyMs,
        },
      ],
      version: '1.0.0',
      debug: debugTest,
    },
    200,
    'no-store'
  );
});

module.exports = router;
