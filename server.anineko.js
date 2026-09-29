/**
 * AniNeko TV — scraper proxy + static host.
 * Watch-only replica. No downloads. Live data scraped from https://anineko.to
 * Run: npm install ; npm start  -> http://localhost:3000
 */
const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://anineko.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 AniNekoTV/1.0';

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

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Referer: BASE + '/' } });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return await res.text();
}

const abs = (u) => (!u ? '' : u.startsWith('http') ? u : u.startsWith('//') ? 'https:' + u : BASE + (u.startsWith('/') ? u : '/' + u));
const slugFromHref = (href) => {
  if (!href) return '';
  const m = href.match(/\/watch\/([a-z0-9\-]+)(?:\/ep\-(\d+))?/i);
  return m ? m[1] : '';
};
const epFromHref = (href) => {
  if (!href) return null;
  const m = href.match(/\/ep\-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
};

function parseCard($, el) {
  const a = $(el).find('a.nv-anime-thumb, a[href*="/watch/"]').first();
  const href = a.attr('href') || $(el).find('a').first().attr('href') || '';
  const img = $(el).find('img').first();
  const titleEl = $(el).find('.nv-anime-title a, h3 a, h3').first();
  const slug = slugFromHref(href);
  if (!slug) return null;
  const genres = $(el).find('.nv-anime-genres span').map((_, s) => $(s).text().trim()).get().filter(Boolean);
  const ccText = $(el).find('.nv-stat-cc').first().text().trim(); // "CC 12"
  const dubText = $(el).find('.nv-stat-dub span:last-child, .nv-stat-dub').first().text().trim();
  const type = $(el).find('.nv-badge-new').first().text().trim();
  return {
    slug,
    title: (titleEl.text() || img.attr('alt') || slug).trim(),
    poster: abs(img.attr('src') || img.attr('data-src') || ''),
    href: '/watch/' + slug,
    genres, type,
    subCount: parseInt((ccText.match(/(\d+)/) || [0, 0])[1], 10) || 0,
    dubCount: parseInt((dubText.match(/(\d+)/) || [0, 0])[1], 10) || 0,
  };
}

// ---------------- HOME ----------------
async function scrapeHome() {
  const html = await fetchPage(BASE + '/home');
  const $ = cheerio.load(html);

  const spotlight = $('.nv-hero-slide').map((_, el) => {
    const title = $(el).find('.nv-hero-title').text().trim();
    const desc = $(el).find('.nv-hero-desc').text().trim();
    const bg = abs($(el).find('img.nv-hero-bg').attr('src') || '');
    const link = $(el).find('a.nv-btn-primary').attr('href') || '';
    const slug = slugFromHref(link);
    const tags = $(el).find('.nv-hero-tags span').map((_, s) => $(s).text().trim()).get();
    const genreLinks = $(el).find('.nv-hero-meta a[href*="/genres/"]').map((_, a) => $(a).text().replace(/^,\s*/, '').trim()).get().filter(Boolean);
    return { slug, title, desc, backdrop: bg, poster: bg, tags, genres: genreLinks };
  }).get().filter((x) => x.slug);

  const featured = $('#nvFeaturedGrid .nv-anime-card').map((_, el) => parseCard($, el)).get().filter(Boolean);

  // Generic section parser: find h2 with text, then collect cards/links in that section
  function sectionCards(heading) {
    const h = $('h2').filter((_, e) => $(e).text().toLowerCase().includes(heading.toLowerCase())).first();
    if (!h.length) return [];
    const sec = h.closest('section');
    const scope = sec.length ? sec : h.parent().parent();
    return scope.find('.nv-anime-card').map((_, el) => parseCard($, el)).get().filter(Boolean);
  }

  // Top trending: numbered links, may not use .nv-anime-card — fallback to raw anchors
  let trending = sectionCards('trending');
  if (!trending.length) {
    const h = $('h2').filter((_, e) => $(e).text().toLowerCase().includes('trending')).first();
    const sec = h.closest('section');
    const anchors = (sec.length ? sec : $('body')).find('a[href*="/watch/"]');
    const seen = new Set(); trending = [];
    anchors.each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!/\/watch\/[a-z0-9\-]+$/i.test(href)) return;
      const slug = slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const img = $(a).find('img').first();
      const title = $(a).find('strong, b').first().text().trim() || img.attr('alt') || slug;
      trending.push({ slug, title, poster: abs(img.attr('src') || ''), href: '/watch/' + slug, genres: [], type: '', subCount: 0, dubCount: 0 });
    });
    trending = trending.slice(0, 10);
  }

  let latest = sectionCards('latest');
  if (!latest.length) {
    // Latest updates cards link to /watch/slug/ep-N
    const h = $('h2').filter((_, e) => $(e).text().toLowerCase().includes('latest')).first();
    const sec = h.closest('section');
    const items = [];
    (sec.length ? sec : $('body')).find('a[href*="/ep-"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const slug = slugFromHref(href);
      const ep = epFromHref(href);
      if (!slug || !ep) return;
      const img = $(a).find('img').first();
      const title = $(a).find('strong').first().text().trim() || img.attr('alt') || slug;
      const meta = $(a).text().replace(/\s+/g, ' ').trim();
      const timeMatch = meta.match(/(\d+\s+(?:hour|minute|day|second)s?\s+ago|NEW)/i);
      items.push({ slug, title, poster: abs(img.attr('src') || ''), episode: ep, href, time: timeMatch ? timeMatch[1] : '', meta: meta.slice(0, 160) });
    });
    // de-dupe by slug+ep
    const seen = new Set();
    latest = items.filter((x) => { const k = x.slug + ':' + x.episode; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 15);
    // attach for frontend: map to card-ish shape too
    latest = latest.map((x) => ({ ...x, genres: [], type: 'TV', subCount: 0, dubCount: 0 }));
  } else {
    latest = latest.slice(0, 15);
  }

  return { spotlight, featured, trending, latest, fetchedAt: new Date().toISOString() };
}

// ---------------- BROWSE / SEARCH ----------------
async function scrapeBrowse(queryString = '') {
  // queryString like "keyword=naruto&page=1&sort=recently_updated"
  const isSearch = /keyword=/.test(queryString);
  const url = (isSearch ? BASE + '/browser?' : BASE + '/browse?') + queryString;
  // /browser and /browse both work; /updates also same layout
  let html;
  try { html = await fetchPage(url); }
  catch { html = await fetchPage(BASE + '/updates?' + queryString); }
  const $ = cheerio.load(html);
  const cards = $('.nv-browse-card, .nv-anime-card').map((_, el) => parseCard($, el)).get().filter(Boolean);
  // de-dupe
  const seen = new Set();
  const results = cards.filter((c) => { if (seen.has(c.slug)) return false; seen.add(c.slug); return true; });
  const totalText = $('.nv-browse-main-title p, .nv-browse-stats').first().text().replace(/\s+/g, ' ').trim();
  return { results, totalText, resultsCount: results.length, fetchedAt: new Date().toISOString() };
}

// ---------------- ANIME DETAILS ----------------
async function scrapeAnime(slug) {
  const html = await fetchPage(`${BASE}/watch/${slug}`);
  const $ = cheerio.load(html);
  const title = $('main h1, .nv-info-main h1').first().text().trim();
  const altTitle = $('.nv-info-alt-title').first().text().trim();
  const desc = $('.nv-info-desc, .nv-info-synopsis p').first().text().trim();
  const poster = abs($('.nv-info-poster img').first().attr('src') || $('.nv-info-bg').attr('src') || '');
  const backdrop = (() => {
    const style = $('.nv-info-bg').first().attr('style') || '';
    const m = style.match(/url\(['"]?(.*?)['"]?\)/);
    return m ? abs(m[1]) : poster;
  })();
  const tags = $('.nv-info-tags span').map((_, s) => $(s).text().trim()).get().filter(Boolean);
  const genres = $('a[href*="/genres/"]').map((_, a) => $(a).text().replace(/^,\s*/, '').trim()).get().filter((t, i, arr) => t && arr.indexOf(t) === i).slice(0, 12);
  const stats = {};
  $('.nv-info-stats div').each((_, d) => {
    const k = $(d).find('span').text().trim().toLowerCase();
    const v = $(d).find('strong').text().trim();
    if (k) stats[k] = v;
  });
  const episodes = $('.nv-info-episode-item').map((_, el) => {
    const a = $(el).find('a.nv-info-episode-main, a[href*="/ep-"]').first();
    const href = a.attr('href') || '';
    const ep = epFromHref(href);
    const epTitle = a.find('span').text().trim();
    const badges = $(el).find('.nv-info-episode-badges span').map((_, s) => $(s).text().trim()).get();
    return ep ? { number: ep, title: epTitle, href, badges } : null;
  }).get().filter(Boolean).sort((a, b) => a.number - b.number);

  if (!title) throw new Error('anime not found: ' + slug);
  return { slug, title, altTitle, desc, poster, backdrop, tags, genres, stats, episodes, episodeCount: episodes.length, fetchedAt: new Date().toISOString() };
}

// ---------------- WATCH / SERVERS ----------------
async function scrapeWatch(slug, ep) {
  const html = await fetchPage(`${BASE}/watch/${slug}/ep-${ep}`);
  const $ = cheerio.load(html);
  const animeTitle = $('.nv-title-main h1, h1').first().text().trim();
  const meta = $('.nv-watch-meta').text().replace(/\s+/g, ' ').trim();

  const langLabels = {};
  $('.server-tab[data-id]').each((_, b) => {
    const id = $(b).attr('data-id');
    const label = $(b).find('strong').text().trim() || id;
    if (id) langLabels[id] = label;
  });

  const servers = { hsub: [], sub: [], dub: [] };
  $('.server-video[data-video]').each((_, b) => {
    const embed = $(b).attr('data-video') || '';
    const tab = $(b).attr('data-tab') || '';
    // map tab_0/1/2 via order of .server-tab, fallback: find parent .lang-group data-id
    const group = $(b).closest('.lang-group').attr('data-id') || '';
    const name = $(b).clone().children().remove().end().text().trim() || $(b).text().trim().split(' ')[0];
    const entry = { name, embed, tab };
    if (group === 'hsub') servers.hsub.push(entry);
    else if (group === 'sub') servers.sub.push(entry);
    else if (group === 'dub') servers.dub.push(entry);
  });
  // fallback if groups missing: split by index
  if (!servers.hsub.length && !servers.sub.length && !servers.dub.length) {
    $('.server-video').each((i, b) => {
      const embed = $(b).attr('data-video') || '';
      const name = $(b).text().trim().split('\n')[0].trim();
      servers.sub.push({ name: name || `Server ${i + 1}`, embed, tab: '' });
    });
  }

  const episodes = $('.nv-episode-item').map((_, a) => {
    const href = $(a).attr('href') || '';
    const n = epFromHref(href);
    const active = $(a).hasClass('active');
    return n ? { number: n, href, active } : null;
  }).get().filter(Boolean).sort((a, b) => a.number - b.number);

  const hasPrev = episodes.some((e) => e.number === ep - 1);
  const hasNext = episodes.some((e) => e.number === ep + 1);
  return { slug, episode: ep, animeTitle, meta, servers, langLabels, episodes, hasPrev, hasNext, fetchedAt: new Date().toISOString() };
}

// ---------------- SCHEDULE ----------------
async function scrapeSchedule() {
  const html = await fetchPage(BASE + '/schedule');
  const $ = cheerio.load(html);
  const items = [];
  $('.nv-schedule-item').each((_, el) => {
    const thumb = $(el).find('a.nv-schedule-thumb[href*="/watch/"]').first();
    const slug = slugFromHref(thumb.attr('href') || '');
    const title = $(el).find('h3').first().text().trim();
    const meta = $(el).find('.nv-schedule-meta').text().replace(/\s+/g, ' ').trim();
    const epM = meta.match(/episode\s+(\d+)/i);
    const ep = epM ? parseInt(epM[1], 10) : null;
    const time = $(el).closest('.nv-time-group').find('.nv-time-label strong').first().text().trim()
      || ($(el).find('.nv-countdown span').first().text().trim().slice(11, 16));
    const status = /released|available/i.test(meta) && !/not released|upcoming|coming soon/i.test(meta) ? 'released' : 'upcoming';
    const poster = abs($(el).find('img').first().attr('src') || '');
    if (!slug || !ep) return;
    items.push({ slug, title: title || slug, episode: ep, href: `/watch/${slug}/ep-${ep}`, time, status, poster, text: meta });
  });
  // fallback to old generic parser
  if (!items.length) {
    $('a[href*="/ep-"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const slug = slugFromHref(href);
      const ep = epFromHref(href);
      if (!slug || !ep) return;
      items.push({ slug, title: slug, episode: ep, href, time: '', status: 'released', poster: '', text: '' });
    });
  }
  const seen = new Set();
  const dedup = items.filter((x) => { const k = x.slug + x.episode; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 60);
  return { items: dedup, fetchedAt: new Date().toISOString() };
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
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || req.query.keyword || '').toString();
    const key = 'search:' + q;
    if (!req.query.refresh) { const c = getCache(key); if (c) return res.json({ ...c, cached: true }); }
    const data = await scrapeBrowse('keyword=' + encodeURIComponent(q));
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
// Turns third-party embed pages into direct playable files.
// vivibebe (HD-1): plain m3u8 in HTML. otakuhg/otakuvid: Dean Edwards packer.
function baseN(n, b) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (n === 0) return '0';
  let s = '';
  while (n > 0) { s = chars[n % b] + s; n = Math.floor(n / b); }
  return s;
}
function unpackPayload(p, a, k) {
  const words = k.split('|');
  const table = {};
  words.forEach((w, i) => { if (w) table[baseN(i, a)] = w; });
  return p.replace(/\b[A-Za-z0-9_$]+\b/g, (w) => table[w] || w);
}
function parsePackerArgs(args) {
  let m = args.match(/,(\d+),(\d+),'(.*)'\.split\('\|'\)/s)
       || args.match(/,(\d+),(\d+),"(.*)"\.split\("\|"\)/s);
  if (!m) return null;
  const q = args.includes("split('|')") ? "'" : '"';
  const pm = args.match(new RegExp('^' + q + '((?:[^' + q + '\\\\]|\\\\.)*)' + q));
  return { p: pm ? pm[1] : null, a: parseInt(m[1], 10), k: m[3] };
}
function parseSubTracks(embedUrl, extraVtt) {
  // anineko SUB embeds carry the .vtt in query params (host-specific keys)
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
    // DUB embeds carry no subs: borrow the episode's English VTT via ?subSrc=
    if (!tracks.length && extraVtt && /^https?:/.test(extraVtt)) {
      push(extraVtt, 'English');
    }
  } catch {}
  // de-dupe + Arabic machine-translation of the first English track
  const seen = new Set();
  const out = tracks.filter((t) => { if (seen.has(t.file)) return false; seen.add(t.file); return true; });
  if (out.length) {
    const en = out[0].file.replace('/api/sub?url=', '/api/sub-ar?url=');
    if (en !== out[0].file) out.push({ label: 'العربية', file: en });
  }
  return out;
}
// ---- English -> Arabic VTT translation (keyless, memory + disk cached) ----
const arCache = new Map();
const AR_CAP = 150;
const crypto = require('crypto');
const fs = require('fs');
const AR_DIR = path.join(__dirname, 'ar_cache');
try { fs.mkdirSync(AR_DIR, { recursive: true }); } catch {}
const arFile = (url) => path.join(AR_DIR, crypto.createHash('md5').update(url).digest('hex') + '.vtt');
async function gtxBatch(cues) {
  // one q-param per cue; response data[0][i] groups segments of cue i
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
    // group = [ [trans, orig, ...], ... ] OR flat [trans, orig, ...] for single-segment
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
      // fall back to smaller batches, then cue-by-cue
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
// Verify a playlist actually serves video: master -> variant -> first segment
// (byte-range). Throws on hotlink-blocked / ad-poisoned links.
async function verifyHls(masterUrl, ref) {
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
  if (!t0.includes('#EXT-X-STREAM-INF')) return; // single-variant playlist, trust it
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

async function resolveEmbed(embedUrl, subSrc) {
  const host = new URL(embedUrl).hostname.toLowerCase();
  const tracks = parseSubTracks(embedUrl, subSrc);
  const pageRef = BASE + '/';
  if (host.includes('vivibebe')) {
    const html = await (await fetchUpstream(embedUrl, pageRef)).text();
    const m = html.match(/const src\s*=\s*"(https?:[^"]+)"/);
    if (!m) throw new Error('vivibebe: no stream found');
    const pm = html.match(/const poster\s*=\s*"([^"]*)"/);
    await verifyHls(m[1], 'https://vivibebe.site/');
    const variants = await parseVariants(m[1], 'https://vivibebe.site/');
    return { type: 'hls', file: m[1], poster: pm ? pm[1] : '', referer: 'https://vivibebe.site/', tracks, playable: true, variants };
  }
  if (host.includes('otakuhg') || host.includes('otakuvid')) {
    const html = await (await fetchUpstream(embedUrl, pageRef)).text();
    const ev = html.match(/eval\(function\(p,a,c,k,e,[rd]\)\{[\s\S]*?\}\(([\s\S]*)\)\)\s*(?:<\/script>|$)/);
    if (!ev) throw new Error('hg/ev: no packed player found');
    const par = parsePackerArgs(ev[1]);
    if (!par || !par.p) throw new Error('hg/ev: packer parse failed');
    const src = unpackPayload(par.p, par.a, par.k);
    const links = {};
    const lm = src.match(/links\s*=\s*\{([^}]+)\}/);
    if (lm) {
      for (const kv of lm[1].matchAll(/"(hls\d+)"\s*:\s*"([^"]+)"/g)) links[kv[1]] = kv[2].replace(/\\/g, '');
    }
    // Prefer ABSOLUTE http(s) links: relative /stream/ entries are ad-poison decoys.
    // Order hls4 > hls3 > hls2 among absolute .m3u8, then absolute .txt mirrors.
    const order = ['hls4', 'hls3', 'hls2'];
    let file = '';
    for (const k of order) {
      const v = links[k] || '';
      if (/^https?:/.test(v) && v.includes('.m3u8')) { file = v; break; }
    }
    if (!file) {
      for (const k of order) {
        const v = links[k] || '';
        if (/^https?:/.test(v) && v.includes('.txt')) { file = v; break; }
      }
    }
    if (!file) {
      const any = src.match(/https?:[^"\\\s]+\.m3u8[^"\\\s]*/);
      if (any) file = any[0];
    }
    if (!file) throw new Error('hg/ev: no stream link found');
    const ref = `https://${host}/`;
    await verifyHls(file, ref);
    const variants = await parseVariants(file, ref);
    const dur = (src.match(/duration\s*:\s*"([\d.]+)"/) || [])[1] || '';
    return { type: 'hls', file, poster: '', referer: ref, tracks, playable: true, duration: dur ? parseFloat(dur) : 0, variants };
  }
  // doodstream etc: not directly resolvable -> player falls back to site iframe
  return { type: 'embed', file: embedUrl, poster: '', referer: pageRef, tracks, playable: false };
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

// HLS / segment proxy (dodges missing CORS on video hosts; rewrites playlists)
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
      const text = buf.toString('utf8').split('\n').map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) {
          // rewrite EXT-X-KEY / MAP URIs
          return line.replace(/URI="([^"]+)"/g, (_, u) => {
            const absU = new URL(u, base).toString();
            return `URI="/api/hls?url=${encodeURIComponent(absU)}&ref=${encodeURIComponent(ref)}"`;
          });
        }
        const absU = new URL(t, base).toString();
        return `/api/hls?url=${encodeURIComponent(absU)}&ref=${encodeURIComponent(ref)}`;
      }).join('\n');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(text);
    }
    // binary segment / key / mp4: pass through with range support
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
      .map((l) => new URL(l, playlistUrl).toString());
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

app.listen(PORT, () => console.log(`AniNeko TV running on http://localhost:${PORT}`));
