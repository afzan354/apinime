/**
 * ═══════════════════════════════════════════════════
 *  AnibiPlay API — Scraper Engine (Axios + Cheerio)
 * ═══════════════════════════════════════════════════
 *  Scrapes anichin.moe for anime/donghua data & video streams.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { getSourceBaseUrl, makeAbsolute, slugify } = require('./helpers');
const { query } = require('./db');

const DEFAULT_USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROVIDER_MAP = {
  'ok.ru': 'Ok.ru',
  'mp4upload': 'Mp4Upload',
  'blogger': 'Blogger',
  'odysee': 'Odysee',
  'streamtape': 'Streamtape',
  'dood': 'Doodstream',
  'filelions': 'FileLions',
  'streamwish': 'StreamWish',
  'vidhide': 'VidHide',
  'rumble': 'Rumble',
  'd.tube': 'D-Tube',
  'streamruby': 'Streamruby',
  'nunadrama': 'NunaPlayer',
};

/**
 * Fetch HTML via Axios (Mendukung Cloudflare Worker Proxy jika disetel di PROXY_URL)
 */
async function fetchHtml(url, timeoutMs = 8000) {
  const proxyUrl = process.env.PROXY_URL || process.env.CLOUDFLARE_WORKER_URL;
  let target = url;
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  };

  // Jika Cloudflare Worker Proxy disetel di environment Vercel
  if (proxyUrl) {
    const cleanProxy = proxyUrl.replace(/\/+$/, '');
    target = `${cleanProxy}/?url=${encodeURIComponent(url)}`;
    if (process.env.PROXY_SECRET) {
      headers['X-Proxy-Secret'] = process.env.PROXY_SECRET;
    }
  }

  try {
    const res = await axios.get(target, {
      timeout: timeoutMs,
      headers,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });
    return res.data;
  } catch (err) {
    console.warn(`[fetchHtml Failed] ${url} (via ${proxyUrl ? 'Proxy' : 'Direct'}):`, err.message);
    return null;
  }
}

/**
 * Scrape episode video stream & mirrors (for POST /play)
 */
/**
 * Ekstrak data stream video dari HTML string (bisa dipanggil dari Vercel atau hasil ingest browser)
 */
function parseStreamFromHtml(html) {
  if (!html) return null;

  const $ = cheerio.load(html);

  // 1. Cari iframe utama (perbaikan selector: iframe[src], bukan iframe[@src])
  let embedUrl = null;
  let provider = 'unknown';

  const firstIframe = $('iframe[src], iframe[data-src]').first();
  if (firstIframe.length) {
    embedUrl = firstIframe.attr('src') || firstIframe.attr('data-src') || null;
  }

  if (embedUrl) {
    for (const [needle, name] of Object.entries(PROVIDER_MAP)) {
      if (embedUrl.toLowerCase().includes(needle)) {
        provider = name;
        break;
      }
    }
  }

  const sources = [];
  const seenUrls = new Set();

  if (embedUrl) {
    seenUrls.add(embedUrl);
    sources.push({
      label: provider !== 'unknown' ? provider : 'Default',
      url: embedUrl,
      type: 'embed',
      height: 720,
    });
  }

  // 2. Ekstrak server mirror dari option select / tab
  const mirrorOptions = $(
    'select.mirror option, ul.mirror a, div.mobius select option'
  );

  mirrorOptions.each((_, el) => {
    const $el = $(el);
    const optVal = $el.attr('value') || $el.attr('data-embed') || $el.attr('href');
    const optName = $el.text().trim();

    if (!optVal || optName.toLowerCase().includes('pilih')) return;

    let extractedSrc = null;

    // Coba decode Base64 jika nilainya iframe HTML yang di-encode
    try {
      const decoded = Buffer.from(optVal, 'base64').toString('utf8');
      const match = decoded.match(/<iframe.*?src=['"]([^'"]+)['"]/i);
      if (match) {
        extractedSrc = match[1];
      }
    } catch (e) {
      // bukan base64
    }

    if (!extractedSrc && (optVal.startsWith('http://') || optVal.startsWith('https://'))) {
      extractedSrc = optVal;
    }

    if (extractedSrc && !seenUrls.has(extractedSrc)) {
      seenUrls.add(extractedSrc);
      let optProvider = 'unknown';
      for (const [needle, name] of Object.entries(PROVIDER_MAP)) {
        if (
          extractedSrc.toLowerCase().includes(needle) ||
          optName.toLowerCase().includes(needle)
        ) {
          optProvider = name;
          break;
        }
      }
      if (optProvider === 'unknown') {
        optProvider = optName.replace(/\[.*?\]/g, '').trim() || 'Mirror';
      }

      if (provider === 'unknown' || provider === 'NunaPlayer') {
        provider = optProvider;
        if (!embedUrl) embedUrl = extractedSrc;
      }

      sources.push({
        label: optProvider,
        url: extractedSrc,
        type: 'embed',
        height: 720,
      });
    }
  });

  if (!embedUrl && sources.length > 0) {
    embedUrl = sources[0].url;
  }

  return {
    provider,
    embedUrl,
    sources,
    subtitles: [
      {
        lang: 'id',
        label: 'Indonesia',
        url: '',
        default: true,
      },
    ],
  };
}

/**
 * Scrape episode video stream & mirrors (for POST /play)
 */
async function scrapeEpisodeStream(episodeSourceUrl, timeoutMs = 8000) {
  const html = await fetchHtml(episodeSourceUrl, timeoutMs);
  if (!html) return null;
  return parseStreamFromHtml(html);
}

/**
 * Parse HTML halaman detail series & simpan ke database TiDB Cloud
 */
async function parseAndSaveSeriesHtml(html, forceSlug = null, explicitUrl = null) {
  if (!html) return null;

  const $ = cheerio.load(html);
  let finalUrl = explicitUrl || (forceSlug ? `${getSourceBaseUrl()}/${forceSlug}/` : '');
  const parsedPath = finalUrl ? new URL(finalUrl).pathname.replace(/^\/+|\/+$/g, '') : '';
  const slug = forceSlug || parsedPath.split('/').pop();

  // 1. Judul
  const title = $('h1').first().text().trim() || slug.replace(/-/g, ' ');

  // 2. Alt Title
  let altTitle = null;
  const firstSpan = $('.info-content span, .spe span').first().text().trim();
  if (firstSpan && !firstSpan.includes(':') && firstSpan.length < 100) {
    altTitle = firstSpan;
  }
  if (!altTitle) {
    const altEl = $('.alter, .alternative').first();
    if (altEl.length) altTitle = altEl.text().trim();
  }

  // 3. Poster & Backdrop
  let poster = null;
  const thumbImg = $('.thumb img, .bigcontent img').first();
  if (thumbImg.length) {
    const src = thumbImg.attr('src') || thumbImg.attr('data-src') || '';
    if (src && !src.startsWith('data:')) poster = makeAbsolute(src);
  }

  let backdrop = null;
  const bannerEl = $('.banner, .bigbanner, .cover').first();
  if (bannerEl.length) {
    const style = bannerEl.attr('style') || '';
    const match = style.match(/url\(['"]?([^'")]+)['"]?\)/);
    if (match) backdrop = makeAbsolute(match[1]);
  }

  // 4. Sinopsis
  let synopsis = '';
  const synParts = [];
  $('.entry-content p, .synp p, div[itemprop="description"] p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 10 && !text.toLowerCase().includes('anichin')) {
      synParts.push(text);
    }
  });
  synopsis = synParts.join(' ');

  if (!synopsis) {
    const rawSyn = $('.entry-content, .synp').first().text().trim();
    synopsis = rawSyn
      .replace(/^sinopsis\s+.*?\]/i, '')
      .replace(/^sinopsis\s+[^:\n]+[:\n]\s*/i, '')
      .replace(/^\[.*?\]\s*/, '')
      .trim();
  }

  // 5. Metadata (Type, Status, Year, Rating)
  let type = 'Donghua';
  let status = 'Ongoing';
  let year = null;
  let rating = 0.0;

  $('.info-content span, .spe span').each((_, el) => {
    const text = $(el).text().trim();
    const stMatch = text.match(/status\s*:?\s*(.*)/i);
    if (stMatch) {
      const s = stMatch[1].toLowerCase();
      if (s.includes('completed') || s.includes('tamat') || s.includes('end')) {
        status = 'Tamat';
      }
    }

    const tpMatch = text.match(/(?:tipe|type)\s*:?\s*(.*)/i);
    if (tpMatch) {
      const t = tpMatch[1].toLowerCase();
      if (t.includes('anime')) type = 'Anime';
      else if (t.includes('movie') || t.includes('film')) type = 'Film';
    }

    const yrMatch = text.match(/(?:rilis|released|tahun|year)\s*:?\s*(?:[a-z]{3}\s*\d{1,2},\s*)?(\d{4})/i);
    if (yrMatch) {
      year = parseInt(yrMatch[1], 10);
    }
  });

  const ratingText = $('.rating strong, .num, div[itemprop="ratingValue"]').first().text().trim();
  const rMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
  if (rMatch) {
    const rVal = parseFloat(rMatch[1]);
    if (rVal > 0 && rVal <= 10) rating = parseFloat(rVal.toFixed(1));
  }

  // 6. Genres
  const genres = [];
  $('.genxed a, .genre a').each((_, el) => {
    const g = $(el).text().trim();
    if (g && g.length < 40 && !genres.includes(g)) genres.push(g);
  });

  // 7. Episodes
  const episodes = [];
  const epNodes = $('.eplister li a, ul.epxs li a');
  epNodes.each((_, el) => {
    const $a = $(el);
    const epHref = makeAbsolute($a.attr('href') || '');
    const epText = $a.text().trim();
    const numText = $a.find('.epl-num').text().trim();
    const ttlText = $a.find('.epl-title').text().trim();
    const dateText = $a.find('.epl-date').text().trim();

    let num = parseInt(numText, 10);
    if (isNaN(num) || num <= 0) {
      const m = epText.match(/(?:episode|ep|eps)\s*(\d+)/i);
      num = m ? parseInt(m[1], 10) : 0;
    }

    let releasedAt = null;
    if (dateText) {
      const dt = new Date(dateText);
      if (!isNaN(dt.getTime())) releasedAt = dt.toISOString().slice(0, 19).replace('T', ' ');
    }

    if (num > 0 && !episodes.some((e) => e.n === num)) {
      episodes.push({
        n: num,
        title: ttlText || `Episode ${num}`,
        source_url: epHref,
        released_at: releasedAt,
      });
    }
  });

  episodes.sort((a, b) => b.n - a.n);
  const latestEpisode = episodes.length > 0 ? Math.max(...episodes.map((e) => e.n)) : 0;
  const accentHue = Math.abs(slug.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360);

  // Simpan / update ke database jika database aktif
  try {
    await query(
      `INSERT INTO series (id, title, alt_title, type, status, year, rating, episode_count, latest_episode, synopsis, poster, backdrop, accent_hue, source_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
          title = COALESCE(NULLIF(VALUES(title), ''), title),
          alt_title = COALESCE(NULLIF(VALUES(alt_title), ''), alt_title),
          synopsis = COALESCE(NULLIF(VALUES(synopsis), ''), synopsis),
          poster = COALESCE(VALUES(poster), poster),
          backdrop = COALESCE(VALUES(backdrop), backdrop),
          type = VALUES(type),
          status = VALUES(status),
          year = COALESCE(VALUES(year), year),
          rating = CASE WHEN VALUES(rating) > 0 THEN VALUES(rating) ELSE rating END,
          latest_episode = GREATEST(latest_episode, VALUES(latest_episode)),
          episode_count = GREATEST(episode_count, VALUES(episode_count)),
          accent_hue = VALUES(accent_hue),
          source_url = VALUES(source_url),
          updated_at = NOW()`,
      [
        slug,
        title,
        altTitle,
        type,
        status,
        year,
        rating,
        episodes.length,
        latestEpisode,
        synopsis,
        poster,
        backdrop,
        accentHue,
        finalUrl,
      ]
    );

    // Simpan genres
    for (const gName of genres) {
      try {
        await query('INSERT IGNORE INTO genres (name) VALUES (?)', [gName]);
        const gRow = await query('SELECT id FROM genres WHERE name = ? LIMIT 1', [gName]);
        if (gRow && gRow.length > 0) {
          await query(
            'INSERT IGNORE INTO series_genres (series_id, genre_id) VALUES (?, ?)',
            [slug, gRow[0].id]
          );
        }
      } catch (gErr) {
        // Abaikan error genre agar episode tetap tersimpan
      }
    }

    // Simpan episodes
    for (const ep of episodes) {
      try {
        await query(
          `INSERT INTO episodes (series_id, n, title, released_at, source_url)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
              title = VALUES(title),
              released_at = COALESCE(VALUES(released_at), released_at),
              source_url = VALUES(source_url)`,
          [slug, ep.n, ep.title, ep.released_at, ep.source_url]
        );
      } catch (epErr) {
        console.warn(`    ✗ Gagal simpan episode ${ep.n}:`, epErr.message);
      }
    }
  } catch (dbErr) {
    console.warn('[Scraper DB Sync Warning]', dbErr.message);
  }

  return {
    id: slug,
    title,
    alt_title: altTitle,
    type,
    status,
    genres,
    rating,
    episode_count: episodes.length,
    latest_episode: latestEpisode,
    synopsis,
    poster,
    backdrop,
    accent_hue: accentHue,
    year,
    updated_at: new Date().toISOString(),
    episodes,
  };
}

/**
 * Scrape halaman detail series & episode-episodenya via backend fetchHtml
 */
async function scrapeSeriesPage(url, forceSlug = null) {
  let finalUrl = makeAbsolute(url);
  let html = await fetchHtml(finalUrl, 9000);

  // Fallback coba variasi URL anichin (dengan atau tanpa prefix /anime/) jika belum berhasil
  if (!html && forceSlug) {
    const candidates = [
      `${getSourceBaseUrl()}/${forceSlug}/`,
      `${getSourceBaseUrl()}/anime/${forceSlug}/`,
    ].filter((u) => u !== finalUrl);

    for (const altUrl of candidates) {
      html = await fetchHtml(altUrl, 9000);
      if (html) {
        finalUrl = altUrl;
        break;
      }
    }
  }

  if (!html) return null;
  return await parseAndSaveSeriesHtml(html, forceSlug, finalUrl);
}

module.exports = {
  fetchHtml,
  scrapeEpisodeStream,
  scrapeSeriesPage,
  parseStreamFromHtml,
  parseAndSaveSeriesHtml,
};

