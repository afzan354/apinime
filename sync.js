/**
 * ═══════════════════════════════════════════════════
 *  AnibiPlay CLI Sync Script (Node.js)
 * ═══════════════════════════════════════════════════
 *
 *  Menarik data dari anichin.moe dan langsung menyimpannya
 *  ke database TiDB Cloud / MySQL.
 *
 *  Penggunaan:
 *    node sync.js              (Scrape katalog hal 1 + jadwal + detail)
 *    node sync.js --pages=2    (Scrape 2 halaman katalog)
 *    node sync.js --schedule   (Scrape jadwal tayang saja)
 */

require('dotenv').config();
const cheerio = require('cheerio');
const { query, checkDb } = require('./src/db');
const { getSourceBaseUrl, makeAbsolute, slugify } = require('./src/helpers');
const { fetchHtml, scrapeSeriesPage, scrapeEpisodeStream } = require('./src/scraper');

// Parse argumen CLI
const args = process.argv.slice(2);
let maxPages = 1;
let scheduleOnly = false;
let streamsOnly = false;
let streamsLimit = 50;

for (const arg of args) {
  if (arg.startsWith('--pages=')) {
    maxPages = Math.max(1, parseInt(arg.split('=')[1], 10) || 1);
  }
  if (arg === '--schedule') {
    scheduleOnly = true;
  }
  if (arg.startsWith('--streams')) {
    streamsOnly = true;
    if (arg.includes('=')) {
      streamsLimit = Math.max(1, parseInt(arg.split('=')[1], 10) || 50);
    }
  }
}

/**
 * Scrape satu halaman katalog (/anime/)
 */
async function scrapeCatalogPage(pageNumber = 1) {
  const baseUrl = getSourceBaseUrl();
  const url = pageNumber === 1 ? `${baseUrl}/anime/` : `${baseUrl}/anime/page/${pageNumber}/`;
  console.log(`\n  📄 Mengambil katalog halaman ${pageNumber}: ${url}`);

  const html = await fetchHtml(url, 8000);
  if (!html) {
    console.log('  ✗ Gagal mengambil halaman katalog.');
    return [];
  }

  const $ = cheerio.load(html);
  const cards = $('div.bsx, article.bs');
  console.log(`  🔍 Ditemukan ${cards.length} judul anime/donghua...`);

  const seriesList = [];

  for (let i = 0; i < cards.length; i++) {
    const card = $(cards[i]);
    const a = card.find('a').first();
    const href = a.attr('href') || '';
    let title = a.attr('title') || a.find('h2, div.tt').first().text().trim();

    if (!href || !title) continue;

    const path = new URL(makeAbsolute(href)).pathname.replace(/^\/+|\/+$/g, '');
    let slug = path.split('/').pop();
    if (!slug || ['anime', 'donghua', 'movie'].includes(slug)) {
      slug = slugify(title);
    }

    const sourceUrl = makeAbsolute(href);

    // Poster
    let poster = null;
    const img = a.find('img').first();
    if (img.length) {
      const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
      if (src && !src.startsWith('data:')) {
        poster = makeAbsolute(src);
      }
    }

    // Tipe
    let type = 'Donghua';
    const typeText = a.find('.typez').text().toLowerCase();
    if (typeText.includes('movie') || typeText.includes('film')) type = 'Film';
    else if (typeText.includes('anime')) type = 'Anime';

    // Status
    let status = 'Ongoing';
    const statusText = a.find('.epx').text().toLowerCase();
    if (statusText.includes('completed') || statusText.includes('tamat') || statusText.includes('end')) {
      status = 'Tamat';
    }

    // Trending badge
    const isHot = a.find('.hotbadge').length > 0;
    const trendingScore = isHot ? 80 : 20;

    try {
      await query(
        `INSERT INTO series (id, title, poster, type, status, source_url, trending_score, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            title = VALUES(title),
            poster = COALESCE(VALUES(poster), poster),
            type = VALUES(type),
            status = VALUES(status),
            source_url = VALUES(source_url),
            trending_score = GREATEST(trending_score, VALUES(trending_score)),
            updated_at = NOW()`,
        [slug, title, poster, type, status, sourceUrl, trendingScore]
      );

      seriesList.push({ id: slug, title, url: sourceUrl });
    } catch (err) {
      console.warn(`    ✗ Gagal menyimpan ${title}:`, err.message);
    }
  }

  console.log(`  ✓ Berhasil menyimpan ${seriesList.length} judul ke database.`);
  return seriesList;
}

/**
 * Scrape halaman jadwal (/schedule/)
 */
async function scrapeSchedule() {
  const url = `${getSourceBaseUrl()}/schedule/`;
  console.log(`\n  📅 Mengambil jadwal tayang: ${url}`);

  const html = await fetchHtml(url, 8000);
  if (!html) {
    console.log('  ✗ Gagal mengambil halaman /schedule/');
    return;
  }

  const $ = cheerio.load(html);

  const dayMap = {
    senin: 'Senin',
    selasa: 'Selasa',
    rabu: 'Rabu',
    kamis: 'Kamis',
    jumat: 'Jumat',
    "jum'at": 'Jumat',
    sabtu: 'Sabtu',
    minggu: 'Minggu',
  };

  let totalSaved = 0;

  // Hapus jadwal lama agar selalu sinkron
  try {
    await query('TRUNCATE TABLE schedule');
  } catch (e) {}

  // Parse container jadwal
  $('div.schedulebtn, div.tab-pane, div.bixbox').each((_, box) => {
    const $box = $(box);
    const heading = $box.find('h2, h3, .section-title, .nav-tabs a.active, .scheduleday').text().toLowerCase();

    let matchedDay = null;
    for (const [key, val] of Object.entries(dayMap)) {
      if (heading.includes(key)) {
        matchedDay = val;
        break;
      }
    }

    if (!matchedDay) return;

    $box.find('.bsx, .schedulebx, article').each(async (_, el) => {
      const $el = $(el);
      const $a = $el.find('a').first();
      const href = $a.attr('href') || '';
      const title = $a.attr('title') || $el.find('.tt, h2').text().trim();
      const timeText = $el.find('.date, .time, .timez').text().trim() || '10:00';

      if (!href || !title) return;

      const path = new URL(makeAbsolute(href)).pathname.replace(/^\/+|\/+$/g, '');
      const slug = path.split('/').pop() || slugify(title);

      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
      const airTime = timeMatch ? `${timeMatch[1]}:00` : '10:00:00';

      try {
        await query(
          'INSERT IGNORE INTO series (id, title, source_url, status) VALUES (?, ?, ?, "Ongoing")',
          [slug, title, makeAbsolute(href)]
        );
        await query(
          'INSERT INTO schedule (series_id, day, air_time) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE air_time = VALUES(air_time)',
          [slug, matchedDay, airTime]
        );
        totalSaved++;
      } catch (err) {}
    });
  });

  console.log(`  ✓ Jadwal tayang tersimpan.`);
}

/**
 * Scrape halaman /donghua/ untuk mencatat rilis episode terbaru (Fresh section)
 */
async function scrapeLatestReleases() {
  const url = `${getSourceBaseUrl()}/donghua/`;
  console.log(`\n  🆕 Mengambil rilis episode terbaru (Fresh section): ${url}`);
  const html = await fetchHtml(url, 8000);
  if (!html) return;

  const $ = cheerio.load(html);
  const cards = $('div.bsx, article.bs, article');
  let count = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = $(cards[i]);
    const a = card.find('a').first();
    const href = makeAbsolute(a.attr('href') || '');
    let title = a.attr('title') || card.find('h2, div.tt').first().text().trim();
    if (!href || !title) continue;

    const m = title.match(/^(.+?)\s+(?:Episode|Ep|Eps)\s+(\d+)/i);
    if (!m) continue;

    const seriesTitle = m[1].trim();
    const epNum = parseInt(m[2], 10);
    const seriesSlug = slugify(seriesTitle);

    try {
      await query(
        'INSERT IGNORE INTO series (id, title, status) VALUES (?, ?, "Ongoing")',
        [seriesSlug, seriesTitle]
      );
      await query(
        `INSERT INTO episodes (series_id, n, title, source_url, released_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            source_url = VALUES(source_url),
            released_at = COALESCE(released_at, NOW())`,
        [seriesSlug, epNum, title, href]
      );
      count++;
    } catch (e) {}
  }

  console.log(`  ✓ Berhasil menyinkronkan ${count} rilis episode terbaru.`);
}

/**
 * Pre-resolve link streaming video (episode_streams) ke database TiDB Cloud
 */
async function syncStreamsForEpisodes(limit = 40) {
  const safeLimit = Math.max(1, parseInt(limit, 10) || 40);
  console.log(`\n  🎬 Menyinkronkan link streaming video (episode_streams)...`);
  const episodesToResolve = await query(
    `SELECT e.id, e.series_id, e.n, e.source_url
     FROM episodes e
     LEFT JOIN episode_streams es ON e.id = es.episode_id AND es.expires_at > NOW()
     WHERE es.id IS NULL AND e.source_url IS NOT NULL AND e.source_url != ''
     ORDER BY e.released_at DESC, e.id DESC
     LIMIT ${safeLimit}`
  );

  console.log(`  Ditemukan ${episodesToResolve.length} episode yang siap di-resolve...`);

  let count = 0;
  for (let i = 0; i < episodesToResolve.length; i++) {
    const ep = episodesToResolve[i];
    process.stdout.write(`    [${i + 1}/${episodesToResolve.length}] ${ep.series_id} Ep ${ep.n}... `);
    try {
      const s = await scrapeEpisodeStream(ep.source_url, 8000);
      if (s && s.embedUrl) {
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        await query(
          `INSERT INTO episode_streams (episode_id, provider, embed_url, stream_data, subtitle_data, resolved_at, expires_at)
           VALUES (?, ?, ?, ?, ?, NOW(), ?)
           ON DUPLICATE KEY UPDATE embed_url = VALUES(embed_url), stream_data = VALUES(stream_data), expires_at = VALUES(expires_at)`,
          [ep.id, s.provider, s.embedUrl, JSON.stringify(s.sources), JSON.stringify(s.subtitles), expiresAt]
        );
        console.log(`✓ (${s.sources.length} mirrors: ${s.provider})`);
        count++;
      } else {
        console.log('✗');
      }
    } catch (err) {
      console.log('✗', err.message);
    }
  }

  console.log(`  ✓ Berhasil menyimpan ${count} link streaming video permanen.`);
}

/**
 * Jalankan proses sinkronisasi
 */
async function main() {
  console.log(`\n  ╔═══════════════════════════════════════════════╗`);
  console.log(`  ║   AnibiPlay — Sync Data ke TiDB Cloud / DB    ║`);
  console.log(`  ╚═══════════════════════════════════════════════╝\n`);

  // Cek koneksi DB
  const isDbOk = await checkDb();
  if (!isDbOk) {
    console.error('  ✗ KONEKSI DATABASE GAGAL!');
    console.error('    Pastikan file vercel/.env sudah diisi dengan data TiDB Cloud Anda.');
    process.exit(1);
  }
  console.log('  ✓ Koneksi database terhubung dengan sukses!\n');

  if (streamsOnly) {
    await syncStreamsForEpisodes(streamsLimit);
    console.log('\n  ✓ Sinkronisasi streaming video selesai!');
    process.exit(0);
  }

  if (scheduleOnly) {
    await scrapeSchedule();
    console.log('\n  ✓ Sinkronisasi jadwal selesai!');
    process.exit(0);
  }

  // 1. Scrape Katalog
  const allSeries = [];
  for (let p = 1; p <= maxPages; p++) {
    const list = await scrapeCatalogPage(p);
    allSeries.push(...list);
  }

  // 2. Scrape Jadwal
  await scrapeSchedule();

  // 3. Scrape Rilis Episode Terbaru (Untuk section Fresh di Home)
  await scrapeLatestReleases();

  // 4. Lengkapi detail & daftar episode per series
  const detailLimit = Math.min(allSeries.length, 25);
  console.log(`\n  📥 Mengambil detail & episode lengkap untuk ${detailLimit} anime...`);
  for (let i = 0; i < detailLimit; i++) {
    const s = allSeries[i];
    process.stdout.write(`    [${i + 1}/${detailLimit}] ${s.title.slice(0, 35)}... `);
    try {
      const res = await scrapeSeriesPage(s.url, s.id);
      const epCount = res && res.episodes ? res.episodes.length : 0;
      console.log(`✓ (${epCount} episode tersimpan)`);
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  // 5. Simpan link streaming video untuk episode-episode terbaru
  await syncStreamsForEpisodes(30);

  console.log(`\n  ═══════════════════════════════════════════════`);
  console.log(`  ✓ Selesai! Seluruh data anime, episode & streaming video berhasil ditarik.`);
  console.log(`  Buka API kamu: https://apinime-omega.vercel.app/api/v1/home\n`);
  process.exit(0);
}

main();
