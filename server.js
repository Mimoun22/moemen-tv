/**
 * Moemen TV — scraper proxy + static host.
 * Watch-only replica. No downloads. Live data scraped from https://aniwaves.ru
 * (9anime-style AJAX: episode list / server list / sources -> echovideo MP4s).
 * Run: npm install ; npm start  -> http://localhost:3000
 */
const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://aniwaves.ru';
const MEGA = 'https://megaplay.buzz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 MoemenTV/1.0';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ---- tiny cache: live refresh but polite (5 min) ----
const cache = new Map();
const TTL = 5 * 60 * 1000;
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > TTL) { cache.delete(key); return null; }
  return e.v;
}
function setCache(key, v) { cache.set(key, { t: Date.now(), v }); }

async function fetchPage(url, ref) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Referer: ref || BASE + '/' } });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return await res.text();
}

async function fetchJson(url, ref) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: ref || BASE + '/' } });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return await res.json();
}

const abs = (u) => (!u ? '' : u.startsWith('http') ? u : u.startsWith('//') ? 'https:' + u : BASE + (u.startsWith('/') ? u : '/' + u));
const imgSrc = ($img) => {
  if (!$img || !$img.length) return '';
  return abs($img.attr('data-src') || $img.attr('src') || $img.attr('data-lazy-src') || '');
};
// App slugs look like "one-piece-81553" (site /watch/ path tail, id included).
// Episode links look like /watch/81553/ep-12.
const slugFromHref = (href) => {
  if (!href) return '';
  const m = href.match(/\/watch\/([a-z0-9\-]+)\/?(?:[?#]|$)/i);
  return m ? m[1] : '';
};
const showIdFromSlug = (slug) => {
  const m = String(slug || '').match(/-(\d+)$/);
  return m ? m[1] : '';
};
const epFromHref = (href) => {
  if (!href) return null;
  const m = href.match(/\/ep-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
};
const num = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0;

// Generic aniwaves card (.ani.items .item, .top-table .item, #top-anime .item)
function parseCard($, el) {
  const $el = $(el);
  const selfHref = $el.is('a[href*="/watch/"]') ? ($el.attr('href') || '') : '';
  const a = $el.find('a[href*="/watch/"]').first();
  const href = selfHref || a.attr('href') || '';
  const slug = slugFromHref(href);
  if (!slug) return null;
  const img = $el.find('img').first();
  const title = ($el.find('a.name, .name.d-title').first().text()
    || $el.find('.film-name').first().text()
    || img.attr('alt') || slug).trim().replace(/\s+Japanese english subbed$/i, '');
  const genres = $el.find('.genre a, a[href*="/genre/"]').map((_, g) => $(g).text().trim()).get()
    .filter((t, i, arr) => t && arr.indexOf(t) === i).slice(0, 5);
  const type = ($el.find('.meta .right, .dot').last().text() || '').trim().split('\n')[0].trim();
  return {
    slug,
    title: title || slug,
    poster: imgSrc(img),
    href: '/watch/' + slug,
    genres, type,
    subCount: num($el.find('.ep-status.sub').first().text()),
    dubCount: num($el.find('.ep-status.dub').first().text()),
  };
}

// ---------------- HOME ----------------
async function scrapeHome() {
  const html = await fetchPage(BASE + '/home');
  const $ = cheerio.load(html);

  // Spotlight slider
  const spotlight = $('#hotest .swiper-slide.item').map((_, el) => {
    const $el = $(el);
    const link = $el.find('a.btn.play').first().attr('href') || '';
    const slug = slugFromHref(link);
    if (!slug) return null;
    const title = $el.find('.d-title').first().text().trim() || slug;
    const desc = $el.find('.synopsis').first().text().trim();
    const style = $el.find('.image div').first().attr('style') || '';
    const bgm = style.match(/url\(['"]?(.*?)['"]?\)/);
    const bg = bgm ? abs(bgm[1]) : '';
    const tags = $el.find('.meta.icons i').map((_, s) => $(s).text().trim()).get().filter(Boolean);
    return { slug, title, desc, backdrop: bg, poster: bg, tags, genres: [] };
  }).get().filter(Boolean);

  // Latest episodes (#recent-update cards carry sub/dub/total counts)
  const latest = [];
  {
    const seen = new Set();
    $('#recent-update .ani.items .item').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href*="/watch/"]').first().attr('href') || '';
      const slug = slugFromHref(link);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const img = $el.find('img').first();
      const title = ($el.find('a.name').first().text() || img.attr('alt') || slug).trim();
      const genres = $el.find('.genre a').map((_, g) => $(g).text().trim()).get().filter(Boolean);
      const ep = num($el.find('.ep-status.sub').first().text()) || num($el.find('.ep-status.total').first().text()) || 1;
      latest.push({
        slug, title, poster: imgSrc(img), episode: ep,
        href: `/watch/${slug}/ep-${ep}`, time: '', meta: '', genres,
        type: 'TV', subCount: num($el.find('.ep-status.sub').first().text()),
        dubCount: num($el.find('.ep-status.dub').first().text()),
      });
    });
  }

  // Featured <- NEW RELEASE top-table; Trending <- #top-anime ranked list
  const tableCards = (name) => $(`.top-table[data-name="${name}"] .item`)
    .map((_, el) => parseCard($, el)).get().filter(Boolean);
  let featured = tableCards('newest').concat(tableCards('added'));
  if (!featured.length) featured = tableCards('completed');
  let trending = $('#top-anime .item').map((_, el) => parseCard($, el)).get().filter(Boolean).slice(0, 12);
  if (!trending.length) trending = tableCards('completed').slice(0, 12);
  featured = featured.slice(0, 18);

  return {
    spotlight: spotlight.slice(0, 10), featured, trending,
    latest: latest.slice(0, 15), fetchedAt: new Date().toISOString(),
  };
}

// ---------------- BROWSE / SEARCH ----------------
// Old frontend calls /api/browse?genre[]=&sort=&page= and /api/search?q=.
// keyword/page -> /filter ; genre -> /genre/<slug> (site has no genre query).
async function scrapeBrowse(queryString = '') {
  const q = new URLSearchParams(queryString);
  const keyword = q.get('keyword') || '';
  const genres = q.getAll('genre[]').concat(q.getAll('genre')).filter(Boolean);
  const page = q.get('page') || '';
  let url;
  if (genres.length && !keyword) {
    url = BASE + '/genre/' + encodeURIComponent(genres[0]);
    if (page) url += '?page=' + encodeURIComponent(page);
  } else {
    const f = new URLSearchParams();
    if (keyword) f.set('keyword', keyword);
    if (page) f.set('page', page);
    url = BASE + '/filter?' + f.toString();
  }
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const seen = new Set();
  const results = $('.ani.items .item, .film-list .item, .item').map((_, el) => parseCard($, el)).get()
    .filter((c) => c && !seen.has(c.slug) && (seen.add(c.slug), true));
  const head = ($('h1').first().text() || $('.page-title').first().text() || '').replace(/\s+/g, ' ').trim();
  return {
    results, totalText: head || `${results.length} titles`,
    resultsCount: results.length, fetchedAt: new Date().toISOString(),
  };
}

// ---------------- ANIME DETAILS ----------------
async function scrapeAnime(slug) {
  const showId = showIdFromSlug(slug);
  if (!showId) throw new Error('anime not found: ' + slug);
  const html = await fetchPage(`${BASE}/watch/${slug}`);
  const $ = cheerio.load(html);
  const titleEl = $('h1.title.d-title').first();
  const title = (titleEl.text() || slug).trim();
  if (!title) throw new Error('anime not found: ' + slug);
  const altTitle = (titleEl.attr('data-jp') || '').trim();
  const desc = ($('.synopsis .text').first().text() || $('meta[property="og:description"]').attr('content') || '').trim();
  let poster = imgSrc($('.binfo .poster img').first());
  if (!poster) poster = abs($('meta[property="og:image"]').attr('content') || '');
  // backdrop: page cover if present, else the wide og:image
  const backdrop = imgSrc($('.cover img, #cover img').first()) || abs($('meta[property="og:image"]').attr('content') || '') || poster;
  const genres = $('.binfo a[href*="/genre/"], .genres a').map((_, a) => $(a).text().trim()).get()
    .filter((t, i, arr) => t && arr.indexOf(t) === i).slice(0, 12);
  // meta rows: label/value pairs in .binfo
  const stats = {};
  $('.binfo .meta .m-item, .binfo .row').each((_, d) => {
    const t = $(d).text().replace(/\s+/g, ' ').trim();
    const m = t.match(/^(Type|Status|Premiered|Aired|Year|Quality|Duration)\s*:?\s*(.+)$/i);
    if (m) stats[m[1].toLowerCase()] = m[2].slice(0, 60);
  });
  const tags = [];
  if (stats.type) tags.push(stats.type);
  tags.push('SUB', 'HD');

  // Episodes via AJAX list
  const list = await fetchJson(`${BASE}/ajax/episode/list/${showId}`, `${BASE}/watch/${slug}`);
  const $$ = cheerio.load((list && list.result) || '');
  const episodes = $$('a[href*="/ep-"]').map((_, a) => {
    const href = $$(a).attr('href') || '';
    const number = parseInt($$(a).attr('data-num') || '0', 10) || epFromHref(href) || 0;
    if (!number) return null;
    const badges = [];
    if ($$(a).attr('data-sub') === '1') badges.push('SUB');
    if ($$(a).attr('data-dub') === '1') badges.push('DUB');
    if ($$(a).attr('data-filler') === '1') badges.push('Filler');
    return { number, title: '', href, badges };
  }).get().filter(Boolean).sort((a, b) => a.number - b.number);

  return {
    slug, title,
    altTitle: altTitle && altTitle !== title ? altTitle : '',
    desc, poster, backdrop, tags, genres,
    stats: { type: stats.type || '', status: stats.status || '', release: stats.premiered || stats.aired || stats.year || '', quality: 'HD' },
    episodes, episodeCount: episodes.length,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------- WATCH / SERVERS ----------------
// embed stored as the raw link-id; resolveEmbed() turns it into video via ajax/sources.
async function scrapeWatch(slug, ep) {
  const showId = showIdFromSlug(slug);
  if (!showId) throw new Error(`anime not found: ${slug}`);
  const anime = await scrapeAnime(slug);
  if (!anime.episodes.some((e) => e.number === ep)) throw new Error(`episode not found: ${slug} ep-${ep}`);
  const srv = await fetchJson(
    `${BASE}/ajax/server/list?servers=${showId}&eps=${ep}`, `${BASE}/watch/${slug}`);
  const $$$ = cheerio.load((srv && srv.result) || '');
  const servers = { hsub: [], sub: [], dub: [] };
  $$$('.servers .type').each((_, t) => {
    const dtype = ($$$(t).attr('data-type') || '').toLowerCase();
    const bucket = dtype === 'dub' ? 'dub' : dtype === 'ssub' ? 'hsub' : 'sub';
    $$$(t).find('li[data-link-id]').each((_, li) => {
      const embed = $$$(li).attr('data-link-id') || '';
      const name = $$$(li).text().trim() || 'Server';
      if (!embed) return;
      servers[bucket].push({ name, embed, tab: dtype });
    });
  });
  const episodes = anime.episodes.map((e) => ({ number: e.number, href: e.href, active: e.number === ep }));
  return {
    slug, episode: ep,
    animeTitle: anime.title,
    meta: `${anime.title} • EP ${ep}`,
    servers,
    langLabels: { sub: 'SUB', dub: 'DUB', hsub: 'S-SUB' },
    episodes,
    hasPrev: episodes.some((e) => e.number === ep - 1),
    hasNext: episodes.some((e) => e.number === ep + 1),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------- SCHEDULE ----------------
// No schedule page: track the /updated listing instead.
async function scrapeSchedule() {
  const html = await fetchPage(BASE + '/updated');
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = $('.ani.items .item, .item').map((_, el) => parseCard($, el)).get()
    .filter((c) => c && !seen.has(c.slug) && (seen.add(c.slug), true))
    .slice(0, 30).map((c) => ({
      slug: c.slug, title: c.title, episode: 1, href: `/watch/${c.slug}`,
      time: '', status: 'released', poster: c.poster, text: (c.genres || []).join(', '),
    }));
  return { items, fetchedAt: new Date().toISOString() };
}

// ---------------- ROUTES ----------------
app.get('/api/health', (_, res) => res.json({ ok: true, base: BASE, time: new Date().toISOString() }));

app.get('/api/home', async (req, res) => {
  try {
    const key = 'home';
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeHome();
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/browse', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const key = 'browse:' + qs;
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeBrowse(qs);
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
async function scrapeSearch(q) {
  // Site search form submits to /filter?keyword=
  const data = await scrapeBrowse('keyword=' + encodeURIComponent(q));
  data.totalText = `${data.resultsCount} results for "${q}"`;
  return data;
}

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || req.query.keyword || '').toString();
    const key = 'search:' + q;
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeSearch(q);
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/anime/:slug', async (req, res) => {
  try {
    const key = 'anime:' + req.params.slug;
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeAnime(req.params.slug);
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/watch/:slug/:ep', async (req, res) => {
  try {
    const ep = parseInt(String(req.params.ep).replace(/\D/g, ''), 10);
    const key = `watch:${req.params.slug}:${ep}`;
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeWatch(req.params.slug, ep);
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/schedule', async (req, res) => {
  try {
    const key = 'schedule';
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeSchedule();
    setCache(key, data);
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------------- STREAM RESOLVER (own player) ----------------
// Primary: aniwaves link-ids -> ajax/sources -> echovideo embed -> getSources
// (MP4 qualities or HLS master). Fallbacks: legacy MegaPlay pages
// (getSourcesNew returns { tracks, enc }; enc is AES-256-CBC decrypting to
// {"file":"...master.m3u8"}; playlists may reference /segment/<token> URLs
// which decrypt the same way) and my.1anime direct-mp4 pages.
const MEGA_KEY = Buffer.concat([Buffer.from('i?LMTAx0Q6,:}50U'), Buffer.alloc(16)]);
const MEGA_IV = Buffer.from("W0;27ToaUpl_P%'c");
function megaDecrypt(token) {
  const b64 = String(token).replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', MEGA_KEY, MEGA_IV);
  return d.update(raw, '', 'utf8') + d.final('utf8');
}
function parseSubTracks(embedUrl, extraVtt) {
  // legacy anineko SUB embeds carried the .vtt in query params (kept for compat)
  const tracks = [];
  try {
    const u = new URL(embedUrl);
    const q = (k) => u.searchParams.get(k) || '';
    const push = (file, label) => {
      if (file && /^https?:/.test(file)) {
        tracks.push({ label: label || 'English', file: '/api/sub?url=' + encodeURIComponent(file), src: file });
      }
    };
    if (q('sub')) push(q('sub'), q('sub_1') || 'English');
    if (q('caption_1')) push(q('caption_1'), q('sub_1') || 'English');
    if (q('c1_file')) push(q('c1_file'), q('c1_label') || 'English');
    if (!tracks.length && extraVtt && /^https?:/.test(extraVtt)) {
      push(extraVtt, 'English');
    }
  } catch {}
  const seen = new Set();
  const out = tracks.filter((t) => { if (seen.has(t.file)) return false; seen.add(t.file); return true; });
  if (out.length) {
    const en = out[0].file.replace('/api/sub?url=', '/api/sub-ar?url=');
    if (en !== out[0].file) out.push({ label: 'العربية', file: en });
  }
  return out;
}
function megaTracks(tracksJson) {
  const out = [];
  for (const t of tracksJson || []) {
    if (t && t.file && /^https?:/.test(t.file)) {
      out.push({
        label: t.label || 'English',
        file: '/api/sub?url=' + encodeURIComponent(t.file),
        src: t.file,
      });
    }
  }
  const seen = new Set();
  const dedup = out.filter((t) => { if (seen.has(t.file)) return false; seen.add(t.file); return true; });
  if (dedup.length) {
    const en = dedup[0].file.replace('/api/sub?url=', '/api/sub-ar?url=');
    if (en !== dedup[0].file) dedup.push({ label: 'العربية', file: en });
  }
  return dedup;
}
// ---- English -> Arabic VTT translation (keyless, memory + disk cached) ----
const arCache = new Map();
const AR_CAP = 150;
const AR_DIR = path.join(__dirname, 'ar_cache');
try { fs.mkdirSync(AR_DIR, { recursive: true }); } catch {}
const arFile = (url) => path.join(AR_DIR, crypto.createHash('md5').update(url).digest('hex') + '.vtt');
async function gtxBatch(cues) {
  const params = new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'ar', dt: 't' });
  for (const t of cues) params.append('q', t);
  const res = await fetch('https://translate.googleapis.com/translate_a/single?' + params.toString(), {
    headers: { 'User-Agent': UA }, redirect: 'follow',
  });
  if (!res.ok) throw new Error('translate ' + res.status);
  const data = await res.json();
  const groups = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  if (groups.length < cues.length) throw new Error('translate shape mismatch');
  return cues.map((_, i) => {
    const segs = Array.isArray(groups[i]) ? groups[i] : [];
    const list = (Array.isArray(segs[0]) ? segs : [segs])
      .filter((s) => Array.isArray(s) && typeof s[0] === 'string')
      .map((s) => s[0]);
    return list.join(' ').trim();
  });
}
async function translateTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 40) {
    const batch = texts.slice(i, i + 40);
    try {
      const got = await gtxBatch(batch);
      if (got.some((t) => !t)) throw new Error('empty segment');
      out.push(...got);
    } catch (e) {
      for (let j = 0; j < batch.length; j += 8) {
        const micro = batch.slice(j, j + 8);
        try {
          const got2 = await gtxBatch(micro);
          if (got2.some((t) => !t) || got2.length !== micro.length) throw new Error('retry');
          out.push(...got2);
        } catch {
          for (const t of micro) {
            try {
              const one = await gtxBatch([t]);
              out.push(one[0] || t);
            } catch { out.push(t); }
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}
async function translateVtt(vttUrl) {
  const hit = arCache.get(vttUrl);
  if (hit) return hit;
  try { const disk = fs.readFileSync(arFile(vttUrl), 'utf8'); if (disk) { arCache.set(vttUrl, disk); return disk; } } catch {}
  const up = await fetchUpstream(vttUrl, BASE + '/');
  const raw = await up.text();
  const blocks = raw.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    cues.push({ time: lines[ti].trim(), text });
  }
  const translated = await translateTexts(cues.map((c) => c.text.replace(/\n+/g, ' ')));
  let vtt = 'WEBVTT - Translated to Arabic (auto)\n\n';
  cues.forEach((c, i) => { vtt += `${c.time}\n${translated[i] || c.text}\n\n`; });
  arCache.set(vttUrl, vtt);
  if (arCache.size > AR_CAP) arCache.delete(arCache.keys().next().value);
  try { fs.writeFileSync(arFile(vttUrl), vtt); } catch {}
  return vtt;
}
async function fetchUpstream(url, ref) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Referer: ref || BASE + '/', Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res;
}
/** List quality variants of a master playlist (best effort, never throws). */
async function parseVariants(masterUrl, ref) {
  try {
    const text = await (await fetchUpstream(masterUrl, ref)).text();
    if (!text.includes('#EXT-X-STREAM-INF')) return [];
    const lines = text.split('\n').map((l) => l.trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [0, 0])[1], 10) || 0;
      const res = (lines[i].match(/RESOLUTION=\d+x(\d+)/) || [0, 0])[1];
      const rel = (lines[i + 1] || '').trim();
      if (!rel || rel.startsWith('#')) continue;
      const h = parseInt(res, 10) || 0;
      out.push({ height: h, bandwidth: bw, url: new URL(rel, masterUrl).toString(), label: h ? h + 'p' : (bw ? Math.round(bw / 1000) + 'k' : 'Auto') });
    }
    return out;
  } catch { return []; }
}
function pickVariant(variants, quality) {
  if (!variants.length) return null;
  const q = parseInt(quality, 10) || 0;
  const sorted = [...variants].sort((a, b) => (b.height || b.bandwidth) - (a.height || a.bandwidth));
  if (!q) return sorted[0];
  const atOrBelow = sorted.filter((v) => (v.height || 1e9) <= q);
  return atOrBelow[atOrBelow.length - 1] || sorted[sorted.length - 1] || sorted[0];
}
function vttToSrt(vtt) {
  const blocks = vtt.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
  let n = 0, out = '';
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length || /^WEBVTT/i.test(lines[0])) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const time = lines[ti].trim().replace(/\./g, ',');
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    out += `${++n}\n${time}\n${text}\n\n`;
  }
  return out;
}
// Verify a playlist actually serves video. Non-fatal for MegaPlay CDN hosts
// (Cloudflare may block datacenter IPs while real browsers pass), so those
// are trusted without a server-side check.
async function verifyHls(masterUrl, ref) {
  if (/nexabloom|zhaevor|megaplay|1anime/i.test(masterUrl)) return;
  const get = (u, range) => fetch(u, {
    headers: { 'User-Agent': UA, Referer: ref, Accept: '*/*', ...(range ? { Range: range } : {}) },
    redirect: 'follow',
  });
  const mustOk = async (u, range) => {
    const r = await get(u, range);
    if (!r.ok && r.status !== 206) throw new Error(`segment check ${r.status}`);
    return r;
  };
  const r0 = await mustOk(masterUrl);
  const t0 = await r0.text();
  if (!t0.includes('#EXT-X-STREAM-INF')) return;
  const lines = t0.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const rel = (lines[idx + 1] || '').replace(/^"/, '').replace(/"$/, '');
  if (!rel || rel.startsWith('#')) throw new Error('no variant found');
  const variantUrl = new URL(rel, masterUrl).toString();
  const r1 = await mustOk(variantUrl);
  const t1 = await r1.text();
  if (!t1.includes('#EXTINF')) throw new Error('bad variant playlist');
  const seg = t1.split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('EXT-'));
  if (!seg) throw new Error('no segments found');
  const segUrl = new URL(seg, variantUrl).toString();
  const r2 = await mustOk(segUrl, 'bytes=0-0');
  const ct = (r2.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('json') || ct.includes('image') || ct.includes('html')) {
    throw new Error('segment blocked (decoy content)');
  }
  await r2.arrayBuffer().catch(() => {});
}

async function resolveMegaEmbed(embedUrl, subSrc, depth = 0) {
  let pageUrl = embedUrl;
  // 1anime.site pages are thin wrappers around the real megaplay iframe
  if (new URL(embedUrl).hostname.includes('1anime.site')) {
    const html = await fetchPage(embedUrl, BASE + '/');
    const m = html.match(/<iframe[^>]*src="([^"]*megaplay[^"]*)"/i);
    if (!m) throw new Error('1anime: no megaplay iframe found');
    pageUrl = m[1].startsWith('http') ? m[1] : 'https:' + m[1];
  }
  const html = await fetchPage(pageUrl, BASE + '/');
  const idM = html.match(/data-id="(\d+)"/);
  if (!idM) throw new Error('megaplay: no media id found');
  const megaId = idM[1];
  const src = await fetchJson(`${MEGA}/stream/getSourcesNew?id=${megaId}`, pageUrl);
  if (!src || !src.enc) throw new Error('megaplay: no sources returned');
  let file = '';
  try {
    const dec = megaDecrypt(src.enc);
    const obj = JSON.parse(dec);
    file = obj.file || '';
  } catch (e) {
    throw new Error('megaplay: stream decrypt failed');
  }
  if (!file) throw new Error('megaplay: no stream link found');
  let tracks = megaTracks(src.tracks);
  // DUB embeds carry no subs: borrow the episode's SUB embed tracks via ?subSrc=
  if (!tracks.length && subSrc && subSrc !== embedUrl && depth < 1) {
    try {
      const borrowed = await resolveMegaEmbed(subSrc, null, depth + 1);
      tracks = borrowed.tracks || [];
    } catch {}
  }
  await verifyHls(file, MEGA + '/');
  let variants = [];
  try { variants = await parseVariants(file, MEGA + '/'); } catch { variants = []; }
  return { type: 'hls', file, poster: '', referer: MEGA + '/', tracks, playable: true, variants };
}

async function resolveMyAnime(embedUrl, subSrc, depth = 0) {
  // my.1anime.site/play/<token>: plain Plyr page with a direct mp4 <source>
  const html = await fetchPage(embedUrl, BASE + '/');
  const m = html.match(/<source[^>]*src="([^"]+)"[^>]*type="video\/mp4"/i)
    || html.match(/<source[^>]*src="([^"]+)"/i);
  if (!m) throw new Error('myanime: no mp4 source found');
  const file = new URL(m[1], embedUrl).toString();
  // the mp4 host requires a same-origin (play page) referer: probe it
  const probe = await fetch(file, {
    headers: { 'User-Agent': UA, Referer: embedUrl, Range: 'bytes=0-0' },
    redirect: 'follow',
  });
  if (!(probe.ok || probe.status === 206)) throw new Error('myanime: stream check ' + probe.status);
  const ct = (probe.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('mp4') && !ct.includes('octet-stream')) throw new Error('myanime: not a video file');
  try { await probe.arrayBuffer(); } catch {}
  let tracks = [];
  if (subSrc && subSrc !== embedUrl && depth < 1) {
    try { tracks = (await resolveEmbed(subSrc, null)).tracks || []; } catch {}
  }
  return { type: 'mp4', file, poster: '', referer: embedUrl, tracks, playable: true, variants: [] };
}

// Aniwaves embeds are stored as raw link-ids: sources API -> echovideo
// embed page -> getSources -> {HD,SD,HQ} MP4s. No subtitles are published.
async function resolveAniwaves(linkId, ref) {
  // One retry: the site occasionally answers AJAX with an HTML challenge page.
  let src = null, lastErr = null;
  for (let attempt = 0; attempt < 2 && !src; attempt++) {
    try {
      src = await fetchJson(
        `${BASE}/ajax/sources?id=${encodeURIComponent(linkId)}&asi=0&autoPlay=0`, ref || BASE + '/');
      if (!src || !src.result || !src.result.url) throw new Error('empty sources');
    } catch (e) { lastErr = e; src = null; }
  }
  if (!src) throw new Error('aniwave: sources unavailable (' + (lastErr && lastErr.message) + ')');
  const embedUrl = src.result.url;
  if (!/echovideo/i.test(embedUrl)) throw new Error('aniwave: unsupported embed host');
  const html = await fetchPage(embedUrl, ref || BASE + '/');
  const idM = html.match(/id="mg-player"[^>]*data-id="([^"]+)"/);
  if (!idM || !idM[1]) throw new Error('aniwave: no media id found');
  const dir = embedUrl.split('?')[0].split('/').slice(0, -1).join('/');
  const gs = await fetchJson(`${dir}/getSources?id=${idM[1]}`, embedUrl);
  const sources = gs && gs.sources;
  if (typeof sources === 'string' && sources.includes('.m3u8')) {
    // embed-1 style: direct HLS master (360/480/720/1080), CDN needs no referer
    const file = sources.startsWith('http') ? sources : new URL(sources, dir).toString();
    const up = await fetchUpstream(file, embedUrl);
    const text = await up.text();
    if (!text.includes('#EXTM3U')) throw new Error('aniwave: bad playlist');
    const variants = await parseVariants(file, embedUrl);
    return { type: 'hls', file, poster: '', referer: embedUrl, tracks: [], playable: true, variants };
  }
  const quals = Object.entries(sources || {})
    .filter(([, v]) => Array.isArray(v) && v[0])
    .map(([label, v]) => ({ label, url: v[0] }));
  if (!quals.length) throw new Error('aniwave: no stream link found');
  const order = { HD: 0, HQ: 1, SD: 2 };
  quals.sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  const file = quals[0].url;
  // range probe (CDN is open, but confirm it's video)
  const probe = await fetch(file, {
    headers: { 'User-Agent': UA, Referer: embedUrl, Range: 'bytes=0-0' }, redirect: 'follow',
  });
  if (!(probe.ok || probe.status === 206)) throw new Error('aniwave: stream check ' + probe.status);
  try { await probe.arrayBuffer(); } catch {}
  const variants = quals.map((q) => ({ height: 0, bandwidth: 0, url: q.url, label: q.label }));
  return { type: 'mp4', file, poster: '', referer: embedUrl, tracks: [], playable: true, variants };
}

async function resolveEmbed(embedUrl, subSrc) {
  if (!/^https?:/i.test(embedUrl || '')) {
    // raw aniwaves link-id (no subtitle tracks are published, nothing to borrow)
    return resolveAniwaves(embedUrl);
  }
  const host = new URL(embedUrl).hostname.toLowerCase();
  if (host.includes('1anime.site')) {
    if (/\/play\//.test(embedUrl)) return resolveMyAnime(embedUrl, subSrc);
    return resolveMegaEmbed(embedUrl, subSrc);
  }
  if (host.includes('megaplay')) {
    return resolveMegaEmbed(embedUrl, subSrc);
  }
  // unknown host: not directly resolvable -> player falls back to site iframe
  return { type: 'embed', file: embedUrl, poster: '', referer: BASE + '/', tracks: parseSubTracks(embedUrl, subSrc), playable: false };
}

const streamCache = new Map();
const STREAM_TTL = 20 * 60 * 1000;

app.get('/api/stream', async (req, res) => {
  try {
    const embed = (req.query.embed || '').toString();
    if (!embed) return res.status(400).json({ error: 'missing embed' });
    const subSrc = (req.query.subSrc || '').toString();
    const key = 'stream:' + embed + '|' + subSrc;
    const ce = streamCache.get(key);
    if (ce && Date.now() - ce.t < STREAM_TTL) return res.json({ ...ce.v, cached: true });
    const data = await resolveEmbed(embed, subSrc);
    data.fetchedAt = new Date().toISOString();
    streamCache.set(key, { t: Date.now(), v: data });
    res.json({ ...data, cached: false });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// HLS / segment proxy (dodges missing CORS on video hosts; rewrites playlists
// and decrypts MegaPlay /segment/<token> URLs server-side)
app.get('/api/hls', async (req, res) => {
  try {
    const url = (req.query.url || '').toString();
    const ref = (req.query.ref || '').toString();
    if (!url) return res.status(400).send('missing url');
    const headers = { 'User-Agent': UA, Referer: ref || BASE + '/', Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, redirect: 'follow' });
    if (!up.ok) return res.status(502).send('upstream ' + up.status);
    const ctype = (up.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await up.arrayBuffer());
    const isPlaylist = ctype.includes('mpegurl') || ctype.includes('m3u') || buf.slice(0, 7).toString() === '#EXTM3U';
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');
    if (isPlaylist) {
      const base = new URL(url);
      const prox = (u) => `/api/hls?url=${encodeURIComponent(u)}&ref=${encodeURIComponent(ref)}`;
      const segRe = /\/segment\/([A-Za-z0-9_\-]+)/g;
      const deSeg = (tok) => {
        try {
          const dec = megaDecrypt(tok).trim();
          const m = dec.match(/https?:[^\s"']+/);
          const real = m ? m[0] : dec;
          return prox(new URL(real, base).toString());
        } catch { return null; }
      };
      let text = buf.toString('utf8');
      text = text.replace(/https?:[^\s"']*\/segment\/[A-Za-z0-9_\-]+/g, (m) => {
        const tok = (m.match(/\/segment\/([A-Za-z0-9_\-]+)/) || [])[1] || '';
        return deSeg(tok) || m;
      });
      text = text.split('\n').map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, u) => {
            if (/\/segment\/[A-Za-z0-9_\-]+/.test(u)) {
              const tok = (u.match(/\/segment\/([A-Za-z0-9_\-]+)/) || [])[1] || '';
              const d = deSeg(tok);
              if (d) return `URI="${d}"`;
            }
            const absU = new URL(u, base).toString();
            return `URI="${prox(absU)}"`;
          });
        }
        if (/^\/segment\/[A-Za-z0-9_\-]+$/.test(t)) {
          const d = deSeg(t.split('/').pop());
          if (d) return d;
        }
        const absU = new URL(t, base).toString();
        return prox(absU);
      }).join('\n');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(text);
    }
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of passthrough) { const v = up.headers.get(h); if (v) res.set(h, v); }
    res.status(up.status === 206 ? 206 : 200).send(buf);
  } catch (e) { res.status(502).send(String(e.message || e)); }
});

// Subtitle proxy (VTT with CORS so <track> elements render)
app.get('/api/sub', async (req, res) => {
  try {
    const url = (req.query.url || '').toString();
    if (!url) return res.status(400).send('missing url');
    const up = await fetchUpstream(url, BASE + '/');
    let text = await up.text();
    if (!text.startsWith('WEBVTT')) text = 'WEBVTT\n\n' + text;
    if ((req.query.format || '') === 'srt') {
      res.set('Content-Type', 'application/x-subrip; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="sub.srt"');
      return res.send(vttToSrt(text));
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(text.startsWith('WEBVTT') ? text : 'WEBVTT\n\n' + text);
  } catch (e) { res.status(502).send(String(e.message || e)); }
});

// Direct episode download (browser fallback; the mobile APK downloads natively).
// Streams concatenated TS segments so the file starts arriving immediately.
app.get('/api/download', async (req, res) => {
  try {
    const embed = (req.query.embed || '').toString();
    const subSrc = (req.query.subSrc || '').toString();
    const quality = (req.query.quality || '').toString();
    const name = ((req.query.name || 'episode') + '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    if (!embed) return res.status(400).send('missing embed');
    const s = await resolveEmbed(embed, subSrc);
    if (!s.playable) return res.status(502).send('not directly downloadable');
    if (s.type === 'mp4') {
      // direct file: stream bytes through with the embed referer
      const up = await fetch(s.file, { headers: { 'User-Agent': UA, Referer: s.referer, Accept: '*/*' }, redirect: 'follow' });
      if (!up.ok || !up.body) return res.status(502).send('upstream ' + up.status);
      res.set('Content-Type', 'video/mp4');
      res.set('Content-Disposition', `attachment; filename="${name}.mp4"`);
      res.set('Access-Control-Allow-Origin', '*');
      const len = up.headers.get('content-length');
      if (len) res.set('Content-Length', len);
      for await (const chunk of up.body) {
        if (req.destroyed) break;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      return res.end();
    }
    let playlistUrl = s.file, ref = s.referer;
    const v = pickVariant(s.variants || [], quality);
    if (v) playlistUrl = v.url;
    let text = await (await fetchUpstream(playlistUrl, ref)).text();
    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      playlistUrl = new URL(lines[idx + 1], playlistUrl).toString();
      text = await (await fetchUpstream(playlistUrl, ref)).text();
    }
    const segs = text.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('EXT-'))
      .map((l) => {
        const m = l.match(/\/segment\/([A-Za-z0-9_\-]+)/);
        if (m) {
          try {
            const dec = megaDecrypt(m[1]).trim();
            const mm = dec.match(/https?:[^\s"']+/);
            return (mm ? mm[0] : dec);
          } catch { /* fall through */ }
        }
        return new URL(l, playlistUrl).toString();
      });
    if (!segs.length) return res.status(502).send('no segments');
    res.set('Content-Type', 'video/mp2t');
    res.set('Content-Disposition', `attachment; filename="${name}.ts"`);
    res.set('Access-Control-Allow-Origin', '*');
    let aborted = false;
    req.on('close', () => { aborted = true; });
    for (const su of segs) {
      if (aborted) break;
      const up = await fetch(su, { headers: { 'User-Agent': UA, Referer: ref, Accept: '*/*' }, redirect: 'follow' });
      if (!up.ok || !up.body) throw new Error('segment ' + up.status);
      for await (const chunk of up.body) {
        if (aborted) break;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (e) {
    try { res.status(502).send(String(e.message || e)); } catch {}
  }
});
// Arabic subtitle proxy (auto-translated from English, cached)
app.get('/api/sub-ar', async (req, res) => {
  try {
    const url = (req.query.url || '').toString();
    if (!url) return res.status(400).send('missing url');
    const vtt = await translateVtt(url);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  } catch (e) { res.status(502).send(String(e.message || e)); }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Moemen TV running on http://localhost:${PORT} (source: ${BASE})`));
}
module.exports = app;