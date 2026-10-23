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
const { fetchHtml, scrapeSeriesPage } = require('./src/scraper');

// Parse argumen CLI
const args = process.argv.slice(2);
let maxPages = 1;
let scheduleOnly = false;

for (const arg of args) {
  if (arg.startsWith('--pages=')) {
    maxPages = Math.max(1, parseInt(arg.split('=')[1], 10) || 1);
  }
  if (arg === '--schedule') {
    scheduleOnly = true;
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

  // 3. Lengkapi detail untuk beberapa series pertama
  const detailLimit = Math.min(allSeries.length, 15);
  console.log(`\n  📥 Mengambil detail & episode untuk ${detailLimit} anime pertama...`);
  for (let i = 0; i < detailLimit; i++) {
    const s = allSeries[i];
    process.stdout.write(`    [${i + 1}/${detailLimit}] ${s.title.slice(0, 35)}... `);
    try {
      await scrapeSeriesPage(s.url, s.id);
      console.log('✓');
    } catch (e) {
      console.log('✗');
    }
  }

  console.log(`\n  ═══════════════════════════════════════════════`);
  console.log(`  ✓ Selesai! Data anime berhasil ditarik ke database.`);
  console.log(`  Buka API kamu: https://apinime.vercel.app/api/v1/home\n`);
  process.exit(0);
}

main();
