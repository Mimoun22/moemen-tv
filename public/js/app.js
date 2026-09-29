/* AniNeko TV — Netflix-style TV UI, live-synced via /api/* proxy. Watch-only. */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const state = {
  view: 'home', home: null, heroIdx: 0, heroTimer: null,
  currentSlug: null, currentEp: 1, watchData: null, lang: 'dub', serverIdx: 0,
  epPage: 0, epPerPage: 60, gridItems: [], lastFetch: null,
};

const api = async (path) => {
  showLoading(true);
  try {
    let j;
    if (window.AniNeko && typeof window.AniNeko.api === 'function') {
      // Native Android TV build: fetch+parse happens in Java (no CORS), live from aniwaves.ru
      j = JSON.parse(window.AniNeko.api(path));
    } else {
      const r = await fetch(path);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    }
    if (j.error) throw new Error(j.error);
    state.lastFetch = new Date();
    paintUpdated(j.fetchedAt);
    return j;
  } catch (e) { toast('Load failed: ' + e.message); throw e; }
  finally { showLoading(false); }
};

function toast(msg, ms=2600){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.add('hidden'),ms); }
function showLoading(on){ $('#loading').classList.toggle('hidden', !on); }
function paintUpdated(iso){
  try { $('#updatedAt').textContent = iso ? ('updated ' + new Date(iso).toLocaleTimeString()) : ''; } catch {}
}
function esc(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function hideBoot(){ $('#boot')?.classList.add('hidden'); }
function showBootRetry(){ $('#bootRetry')?.classList.remove('hidden'); }

/* Mirror UI state to the native Android shell (for remote BACK handling) */
function notifyNative(){
  try {
    if (window.AniNeko && typeof window.AniNeko.setState === 'function') {
      window.AniNeko.setState(JSON.stringify({
        playerOpen: playerOpen(),
        searchOpen: !$('#searchBar').classList.contains('hidden'),
        view: state.view }));
    }
  } catch {}
}
const playerOpen = () => !$('#player').classList.contains('hidden');
function closePlayer(){
  try { if(typeof OwnPlayer !== 'undefined' && OwnPlayer.isOpen) OwnPlayer.close(); } catch {}
  $('#player').classList.add('hidden');
  try { $('#frame').src = 'about:blank'; } catch {}
  notifyNative();
}

/* ---------- Continue watching / My list (local only) ---------- */
const store = {
  get(k, d){ try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};
function getContinue(){ return store.get('anineko.continue', {}); }
function saveContinue(slug, data){ const c=getContinue(); c[slug]={...data, at:Date.now()}; store.set('anineko.continue', c); }
function getList(){
  const raw = store.get('anineko.mylist', []);
  if(!Array.isArray(raw)) return [];
  // migrate legacy slug-only entries
  return raw.map((x) => typeof x === 'string' ? { slug: x, title: '', poster: '' } : x)
    .filter((x) => x && x.slug);
}
function inList(slug){ return getList().some((x) => x.slug === slug); }
function toggleList(slug, meta){
  let l = getList();
  const has = l.some((x) => x.slug === slug);
  if(has) l = l.filter((x) => x.slug !== slug);
  else l = [{ slug, title: (meta && meta.title) || '', poster: (meta && meta.poster) || '', at: Date.now() }, ...l];
  store.set('anineko.mylist', l);
  return !has;
}

/* ---------- HOME ---------- */
async function loadHome(refresh=false){
  setView('home');
  try {
    const data = await api('/api/home' + (refresh ? '?refresh=1' : ''));
    state.home = data;
    renderHero(data.spotlight);
    renderRows(data);
    hideBoot();
    focusFirst();
  } catch (e) { showBootRetry(); throw e; }
}
function renderHero(list){
  if(!list?.length) return;
  state.heroIdx = 0;
  const paint = () => {
    const h = list[state.heroIdx % list.length];
    $('#heroBg').src = h.backdrop || h.poster || '';
    $('#heroTitle').textContent = h.title;
    const avail = [...new Set([...(h.tags || [])].filter((t) => /^(SUB|DUB|TV|Movie|ONA|OVA)$/i.test(t)))];
    const genres = (h.genres || []).slice(0, 4).join(', ');
    $('#heroMeta').innerHTML = (avail.length ? `<b>${avail.join(' | ')}</b>` : '')
      + (genres ? `<span>${esc(genres)}</span>` : '');
    $('#heroDesc').textContent = h.desc || '';
    $('#heroAudio').innerHTML = audioLine(h.tags);
    $('#hero').dataset.slug = h.slug;
    const inL = inList(h.slug);
    $('#heroList').textContent = inL ? '✓' : '+';
    $('#heroList').classList.toggle('on', inL);
    $('#heroDots').innerHTML = list.slice(0,7).map((_,i)=>`<i class="${i===(state.heroIdx%list.length)?'on':''}"></i>`).join('');
  };
  paint();
  clearInterval(state.heroTimer);
  state.heroTimer = setInterval(()=>{ state.heroIdx++; paint(); }, 9000);
}
/* "Audio: Japanese, English / Subtitles: English" from SUB/DUB tags */
function audioLine(tags){
  tags = tags || [];
  const has = (t) => tags.some((x) => String(x).toUpperCase() === t);
  const audio = has('DUB') ? 'Japanese, English' : has('SUB') ? 'Japanese' : '';
  const subs = has('SUB') || has('HSUB') ? 'English' : '';
  if(!audio && !subs) return '';
  return `${audio ? `<b>Audio:</b> ${audio}` : ''}${audio && subs ? ' &nbsp;•&nbsp; ' : ''}${subs ? `<b>Subtitles:</b> ${subs}` : ''}`;
}
function cardHTML(c, extra='', rank=0){
  return `<div class="cardwrap${rank ? ' ranked' : ''}">${rank ? `<div class="rankbig">${rank}</div>` : ''}<div class="card" data-focusable data-slug="${c.slug}"${c.epNum ? ` data-ep="${c.epNum}" data-action="play"` : ' data-action="open"'}>
    <img loading="lazy" src="${esc(c.poster)}" alt="${esc(c.title)}">
    <div class="t">${esc(c.title)}${c.pct ? `<div class="cprog"><i style="width:${c.pct}%"></i></div>` : ''}</div>
    <div class="g">${esc((c.genres||[]).slice(0,2).join(' • '))} ${c.subCount?('• CC '+c.subCount):''}</div>
  </div>${extra}</div>`;
}
function renderRows(d){
  const rows = $('#rows'); rows.innerHTML = '';
  const cont = getContinue();
  const contItems = Object.entries(cont).sort((a,b)=>b[1].at-a[1].at).slice(0,12)
    .map(([slug,v])=>({slug, title:v.title, poster:v.poster, genres:[`EP ${v.ep}`],
      pct: (v.pos && v.dur) ? Math.round((v.pos / v.dur) * 100) : 0,
      epNum: v.ep }));
  const mk = (title, sub, items, isEp=false, ranked=false) => {
    if(!items?.length) return '';
    const cards = items.map((c,i)=>{
      if(isEp) return `<div class="cardwrap"><div class="card" data-focusable data-slug="${c.slug}" data-ep="${c.episode}" data-action="play"><div class="rank">#${i+1}</div>
        <img loading="lazy" src="${esc(c.poster)}" alt=""><div class="t">${esc(c.title)}</div>
        <div class="g">EP ${c.episode} ${c.time?'• '+esc(c.time):''}</div></div></div>`;
      if(ranked) return cardHTML(c, '', i + 1);
      return cardHTML(c);
    }).join('');
    return `<section class="row"><h2>${esc(title)}</h2><div class="sub">${esc(sub)} • live from aniwave</div><div class="rail">${cards}</div></section>`;
  };
  const mkList = (title, sub, items) => {
    if(!items?.length) return '';
    const cards = items.map((c) => `<div class="lrow" data-focusable data-slug="${c.slug}" data-ep="${c.episode}" data-action="play">
        ${c.poster ? `<img loading="lazy" src="${esc(c.poster)}" alt="">` : ''}
        <div class="lbody"><b>${esc(c.title)}</b><small>Episode ${c.episode}${c.time ? ' • ' + esc(c.time) : ''}</small></div>
        <div class="lgo">▶</div>
      </div>`).join('');
    return `<section class="row"><h2>${esc(title)}</h2><div class="sub">${esc(sub)} • live from aniwave</div><div class="lrail">${cards}</div></section>`;
  };
  rows.innerHTML =
    (contItems.length ? mk('Continue Watching','pick up where you left off', contItems) : '') +
    mk('Top Trending','most watched right now', d.trending?.slice(0,10), false, true) +
    mkList('Latest Updates','fresh episodes just dropped', d.latest?.slice(0,10)) +
    mk('Featured Anime','hand-picked', d.featured?.slice(0,18));
  wireCards(rows);
}

/* ---------- GRID views ---------- */
const GENRES = ['action','adventure','comedy','drama','fantasy','isekai','romance','horror','sci-fi','sports','mystery','slice-of-life'];
function setView(v){
  state.view = v;
  ['home','grid','details'].forEach(x=>$('#view-'+x).classList.toggle('hidden', x!==v));
  $$('#nav button').forEach(b=>b.classList.toggle('active', b.dataset.nav===v));
  notifyNative();
}
async function loadBrowse(genre=''){
  setView('grid'); state.gridMode = 'browse'; $('#gridTitle').textContent='Browse Anime'; $('#gridSub').textContent='Live library • '+ (genre||'all genres');
  $('#genreChips').innerHTML = ['<button data-focusable data-g="" class="'+(!genre?'on':'')+'">All</button>',
    ...GENRES.map(g=>`<button data-focusable data-g="${g}" class="${g===genre?'on':''}">${g}</button>`)].join('');
  $$('#genreChips button').forEach(b=>b.onclick=()=>loadBrowse(b.dataset.g));
  const qs = genre ? `?genre[]=${genre}&sort=recently_updated` : '?sort=recently_updated';
  const d = await api('/api/browse'+qs);
  paintGrid(d.results, d.totalText || `${d.resultsCount} titles`);
}
async function loadLatest(){
  setView('grid'); state.gridMode = 'latest'; $('#gridTitle').textContent='Latest Updates'; $('#genreChips').innerHTML='';
  const d = await api('/api/browse?sort=recently_updated');
  $('#gridSub').textContent = d.totalText || 'fresh from aniwave';
  paintGrid(d.results, '');
}
async function loadSchedule(){
  setView('grid'); state.gridMode = 'schedule'; $('#gridTitle').textContent="Today's Schedule"; $('#genreChips').innerHTML='';
  const d = await api('/api/schedule?refresh=1');
  $('#gridSub').textContent = `${d.items.length} releases tracked live`;
  $('#grid').innerHTML = d.items.map(s=>`<div class="cardwrap"><div class="card" data-focusable data-slug="${s.slug}" data-ep="${s.episode}" data-action="play">
    ${s.poster?`<img loading="lazy" src="${esc(s.poster)}" alt="">`:''}<div class="t">${esc(s.title||s.slug)} — EP ${s.episode}</div><div class="g">${esc(s.time||'')} • ${esc(s.status)}</div></div></div>`).join('') || '<p style="padding:20px">No schedule items parsed.</p>';
  wireCards($('#grid')); focusFirst();
}
async function doSearch(q){
  if(!q) return;
  setView('grid'); state.gridMode = 'search'; $('#gridTitle').textContent=`Search: ${q}`; $('#genreChips').innerHTML='';
  const d = await api('/api/search?q='+encodeURIComponent(q));
  paintGrid(d.results, d.totalText || `${d.resultsCount} results`);
}
function paintGrid(items, sub){
  state.gridItems = items;
  if(sub) $('#gridSub').textContent = sub;
  $('#grid').innerHTML = items.map((c) => cardHTML(c)).join('') || '<p style="padding:20px">No results.</p>';
  wireCards($('#grid')); focusFirst();
}

/* ---------- DETAILS ---------- */
async function openAnime(slug){
  setView('details');
  $('#dTitle').textContent='Loading…'; $('#epGrid').innerHTML='';
  $('#dMetaLine').innerHTML=''; $('#dAv').innerHTML=''; $('#dFacts').innerHTML='';
  const d = await api('/api/anime/'+slug);
  state.currentSlug = slug; state.epPage = 0; state.details = d;
  $('#dBackdrop').src = d.backdrop || d.poster || '';
  $('#dPoster').src = d.poster || '';
  $('#dKicker').textContent = '★ ' + ((d.tags || []).find((t) => /^(TV|Movie|ONA|OVA|Special)$/i.test(t)) || 'SERIES').toUpperCase();
  $('#dTitle').textContent = d.title;
  $('#dAlt').textContent = d.altTitle && d.altTitle !== d.title ? d.altTitle : '';
  const av = [...new Set((d.tags || []).filter((t) => /^(SUB|DUB)$/i.test(t)).map((t) => t.toUpperCase()))];
  const genres = (d.genres || []).slice(0, 5).join(', ');
  $('#dMetaLine').innerHTML = (av.length ? `<b>${av.join(' | ')}</b>` : '')
    + (genres ? `<span>${esc(genres)}</span>` : '');
  $('#dAv').innerHTML = audioLine(d.tags);
  $('#dDesc').textContent = d.desc || '';
  const st = d.stats || {};
  const facts = [['Type', st.type], ['Status', st.status], ['Release', st.release || st.year],
    ['Quality', st.quality], ['Episodes', d.episodeCount]].filter(([, v]) => v);
  $('#dFacts').innerHTML = facts.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('');
  $('#dMeta').innerHTML = [...(d.tags || []), ...(d.genres || [])].slice(0, 8).map((t) => `<span>${esc(t)}</span>`).join('');
  $('#epCount').textContent = `(${d.episodeCount})`;
  const c = getContinue()[slug];
  $('#dPlay').textContent = (c && c.ep) ? `⏵ Resume EP ${c.ep}` : (d.episodes.length ? `▶ Watch E1` : '▶ Play');
  syncListBtn();
  paintEps();
  $('#dBack').focus();
}
function syncListBtn(){
  const inL = inList(state.currentSlug);
  $('#dWatchlist').textContent = inL ? '✓' : '+';
  $('#dWatchlist').classList.toggle('on', inL);
}
function paintEps(){
  const eps = state.details?.episodes || [];
  const pages = Math.max(1, Math.ceil(eps.length / state.epPerPage));
  state.epPage = Math.min(state.epPage, pages-1);
  const slice = eps.slice(state.epPage*state.epPerPage, (state.epPage+1)*state.epPerPage);
  const cont = getContinue()[state.currentSlug];
  const poster = state.details?.poster || '';
  $('#epGrid').innerHTML = slice.map(e=>{
    const cls = cont && e.number < cont.ep ? 'watched' : (cont && e.number===cont.ep ? 'cont' : '');
    return `<div class="eprow ${cls}" data-focusable data-slug="${state.currentSlug}" data-ep="${e.number}" data-action="play">
      ${poster ? `<img class="epthumb" loading="lazy" src="${esc(poster)}" alt="">` : ''}
      <div class="epnum">${e.number}</div>
      <div class="epbody"><b>Episode ${e.number}</b><small>${esc(e.title || (e.badges || []).join(' • '))}</small></div>
      <div class="epbadges">${(e.badges || []).map((b) => `<span>${esc(b)}</span>`).join('')}</div>
      <button class="dlbtn" data-focusable data-dl="${e.number}" title="Download EP ${e.number}">⤓</button>
      <div class="epgo">▶</div>
    </div>`;
  }).join('') + (pages>1?`<p style="grid-column:1/-1;color:var(--mut)">Page ${state.epPage+1}/${pages} • ${eps.length} episodes</p>`:'');
  wireCards($('#epGrid'));
  $$('#epGrid [data-dl]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openDl(state.currentSlug, +b.dataset.dl, state.details?.title || ''); };
    b.onmouseenter = () => setFocus(b);
  });
}

/* ---------- PLAYER ---------- */
// Bridge-native playback (Android APK) vs own HTML5 player (browser)
async function playEpisode(slug, ep){
  if(!slug) return;
  ep = Math.max(1, +ep || 1);
  showLoading(true);
  try {
    const [w, a] = await Promise.all([
      api(`/api/watch/${slug}/ep-${ep}`),
      api('/api/anime/' + slug).catch(() => null),
    ]);
    state.watchData = w; state.currentSlug = slug; state.currentEp = ep;
    if(!['sub','dub','hsub'].includes(state.lang) || !(w.servers[state.lang] || []).length){
      // default: DUB if available, else HSUB, else SUB
      state.lang = (w.servers.dub || []).length ? 'dub' : (w.servers.hsub || []).length ? 'hsub' : 'sub';
    }
    const payload = { slug, ep, title: w.animeTitle || (a && a.title) || slug,
      poster: (a && (a.poster || a.backdrop)) || '',
      lang: state.lang, servers: w.servers,
      episodes: (w.episodes || []).map((e) => e.number) };
    // resume position (seconds) for the native player; web player reads the store itself
    try {
      const cont = getContinue()[slug];
      payload.pos = (cont && cont.ep === ep && cont.pos > 10) ? cont.pos : 0;
    } catch { payload.pos = 0; }
    if(window.AniNeko && typeof window.AniNeko.playNative === 'function'){
      saveContinue(slug, { title: payload.title, poster: payload.poster, ep, pos: 0, dur: 0 });
      window.AniNeko.playNative(JSON.stringify(payload));
      return;
    }
    $('#player').classList.remove('hidden');
    OwnPlayer.open(payload);
  } catch(e) { /* api() already toasted */ }
  finally { showLoading(false); }
}
// Called by native ExoPlayer when it closes: persist watch position
window.__aninekoProgress = (slug, ep, pos, dur, title, poster) => {
  try {
    const c = getContinue();
    const prev = c[slug] || {};
    c[slug] = { title: title || prev.title || slug, poster: poster || prev.poster || '',
      ep, pos: pos || 0, dur: dur || 0, at: Date.now() };
    store.set('anineko.continue', c);
  } catch {}
};
window.__playEp = (slug, ep) => playEpisode(slug, ep);
window.__focus = (el) => setFocus(el);
function cycleServer(d=1){ if(OwnPlayer.isOpen) OwnPlayer.menuServers(); }
function cycleLang(){ if(OwnPlayer.isOpen) OwnPlayer.menuLang(); }

/* ---------- DOWNLOADS (mobile; hidden on TV) ---------- */
const DL = { slug: null, ep: 1, title: '', watch: null, lang: 'sub', stream: null, quality: 0, dur: 0 };
const hasNativeDl = () => !!(window.AniNeko && typeof window.AniNeko.downloadEpisode === 'function');
function fmtMB(bytes) {
  if (!bytes || bytes <= 0) return '';
  return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(1) + ' GB' : Math.round(bytes / 1048576) + ' MB';
}
async function openDl(slug, ep, title) {
  Object.assign(DL, { slug, ep, title, watch: null, lang: 'sub', stream: null, quality: 0, dur: 0 });
  $('#dlTitle').textContent = `${title || slug} — EP ${ep}`;
  $('#dlLangs').innerHTML = '<span style="color:var(--mut)">Loading audio versions…</span>';
  $('#dlQuals').innerHTML = '';
  $('#dlSub').innerHTML = '';
  $('#dlProg').classList.add('hidden');
  $('#dlStat').textContent = '';
  $('#dlModal').classList.remove('hidden');
  try {
    const w = await api(`/api/watch/${slug}/ep-${ep}`);
    DL.watch = w;
    DL.dur = 0;
    DL.lang = (w.servers.sub || []).length ? 'sub' : (w.servers.dub || []).length ? 'dub' : 'hsub';
    paintDlLangs();
    await resolveDlServer();
  } catch (e) { $('#dlLangs').innerHTML = '<span style="color:var(--mut)">Failed to load. Check connection.</span>'; }
}
function paintDlLangs() {
  const langs = ['sub', 'dub', 'hsub'].filter((l) => ((DL.watch?.servers || {})[l] || []).length);
  $('#dlLangs').innerHTML = langs.map((l) =>
    `<button data-focusable data-dl-lang="${l}" class="${l === DL.lang ? 'on' : ''}">${l.toUpperCase()}</button>`).join('');
  [...$('#dlLangs').children].forEach((b) => {
    b.onclick = async () => { DL.lang = b.dataset.dlLang; DL.quality = 0; paintDlLangs(); await resolveDlServer(); };
    b.onmouseenter = () => setFocus(b);
  });
}
function dlSubSrc() {
  // borrow the episode's English VTT so DUB downloads get subs too
  for (const l of ['sub', 'dub', 'hsub']) {
    const hit = (((DL.watch || {}).servers || {})[l] || []).find((s) => /[?&](sub=|caption_1=|c1_file=)/.test(s.embed || ''));
    if (hit) return hit.embed;
  }
  const sub = ((((DL.watch || {}).servers || {}).sub || [])[0] || {}).embed || '';
  return sub;
}
async function resolveDlServer() {
  const list = (((DL.watch || {}).servers || {})[DL.lang] || []);
  $('#dlQuals').innerHTML = '<div class="spin"></div>';
  $('#dlSub').innerHTML = '';
  DL.stream = null;
  const subSrc = dlSubSrc();
  for (const s of list) {
    try {
      let url = '/api/stream?embed=' + encodeURIComponent(s.embed);
      if (subSrc && subSrc !== s.embed) url += '&subSrc=' + encodeURIComponent(subSrc);
      const st = await api(url);
      if (st.playable) { DL.stream = { ...st, serverName: s.name, embed: s.embed }; DL.dur = st.duration || 0; break; }
    } catch (e) { /* next server */ }
  }
  if (!DL.stream) { $('#dlQuals').innerHTML = '<span style="color:var(--mut)">No downloadable source on ' + DL.lang.toUpperCase() + '.</span>'; return; }
  paintDlQuals();
}
function paintDlQuals() {
  const vars = DL.stream.variants || [];
  const dur = DL.dur || 0;
  const est = (bw) => (bw && dur ? '~' + fmtMB((bw * dur) / 8) : '');
  const opts = [{ label: 'Best', height: 0, sub: (vars[0]?.label || '') + ' ' + est(vars[0]?.bandwidth) },
    ...vars.map((v) => ({ label: v.label, height: v.height || 0, sub: est(v.bandwidth) }))];
  $('#dlQuals').innerHTML = opts.map((o, i) =>
    `<button data-focusable data-dl-q="${o.height}" class="${(DL.quality || 0) === o.height ? 'on' : ''}"><span>${esc(o.label)}</span><small>${esc(o.sub)}</small></button>`).join('');
  [...$('#dlQuals').children].forEach((b) => {
    b.onclick = () => { DL.quality = +b.dataset.dlQ; paintDlQuals(); };
    b.onmouseenter = () => setFocus(b);
  });
  const en = (DL.stream.tracks || []).find((t) => /english/i.test(t.label));
  $('#dlSub').innerHTML = en
    ? `Subtitles included: English + العربية <a id="dlSubDl" href="${esc(en.file)}&format=srt" download>save .srt</a>`
    : 'No subtitles on this source.';
}
function closeDl() { $('#dlModal').classList.add('hidden'); }
function startDownload() {
  if (!DL.stream) { toast('Pick a quality first'); return; }
  const q = DL.quality || 0;
  const name = `${DL.title || DL.slug} EP${DL.ep} [${DL.lang.toUpperCase()}]${q ? ` [${q}p]` : ''}`;
  const en = (DL.stream.tracks || []).find((t) => /english/i.test(t.label));
  if (hasNativeDl()) {
    window.AniNeko.downloadEpisode(JSON.stringify({ slug: DL.slug, ep: DL.ep, title: DL.title,
      lang: DL.lang, embed: DL.stream.embed, quality: q,
      subUrl: en && en.src ? en.src : '', subLabel: 'English', name }));
    toast('Download started — watch the notification');
    closeDl();
    return;
  }
  // browser fallback: direct file download via the proxy
  let url = '/api/download?embed=' + encodeURIComponent(DL.stream.embed) + '&quality=' + q + '&name=' + encodeURIComponent(name);
  if (dlSubSrc()) url += '&subSrc=' + encodeURIComponent(dlSubSrc());
  const a = document.createElement('a');
  a.href = url; a.download = name + '.ts';
  document.body.appendChild(a); a.click(); a.remove();
  $('#dlStat').textContent = 'Downloading via browser…';
}

/* ---------- card wiring ---------- */
function wireCards(root){
  $$('[data-action]', root).forEach(el=>{
    el.onclick = (e)=>{ e.stopPropagation(); handleAction(el); };
  });
  $$('[data-focusable]', root).forEach(el=>{ if(!el.onmouseenter) el.onmouseenter=()=>setFocus(el); });
}
async function loadMyList(){
  setView('grid');
  state.gridMode = 'mylist';
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === 'mylist'));
  $('#gridTitle').textContent = 'My List';
  $('#genreChips').innerHTML = '';
  let items = getList();
  // fill in missing posters/titles live (self-healing for legacy entries)
  const missing = items.filter((x) => !x.poster || !x.title);
  if(missing.length){
    $('#gridSub').textContent = 'Syncing your list…';
    const filled = await Promise.all(missing.map((x) =>
      api('/api/anime/' + x.slug).then((d) => ({ ...x, title: d.title, poster: d.poster })).catch(() => x)));
    const bySlug = Object.fromEntries(filled.map((x) => [x.slug, x]));
    items = items.map((x) => bySlug[x.slug] || x);
    store.set('anineko.mylist', items);
  }
  if(!items.length){
    $('#gridSub').textContent = 'Nothing here yet';
    $('#grid').innerHTML = '<p style="padding:20px;color:var(--mut)">Your list is empty — open any series and press + to save it here.</p>';
    focusFirst();
    return;
  }
  paintGrid(items.map((x) => ({ slug: x.slug, title: x.title || x.slug, poster: x.poster || '',
    genres: [], type: '', subCount: 0, dubCount: 0 })), `${items.length} saved series`);
}
function handleAction(el){
  const a = el.dataset.action;
  if(a==='open') openAnime(el.dataset.slug);
  if(a==='play') playEpisode(el.dataset.slug, +(el.dataset.ep||1));
  if(a==='home') loadHome();
  if(a==='search') toggleSearch(true);
  if(a==='settings') toggleSettings();
  if(a==='refresh') refreshCurrent();
  if(a==='hero-play' || el.id==='heroPlay'){ const s=$('#hero').dataset.slug; if(s) openAnime(s); }
  if(a==='hero-info'){ const s=$('#hero').dataset.slug; if(s) openAnime(s); }
  if(a==='hero-list'){
    const s = $('#hero').dataset.slug; if(!s) return;
    const h = (state.home?.spotlight || []).find((x) => x.slug === s);
    const added = toggleList(s, { title: h?.title, poster: h?.poster });
    toast(added ? 'Added to My List' : 'Removed from My List');
    $('#heroList').textContent = added ? '✓' : '+';
    $('#heroList').classList.toggle('on', added);
  }
}

/* ---------- TV D-pad / spatial nav ---------- */
let focusEl = null;
function focusables(){ return $$('[data-focusable]').filter(el=>el.offsetParent!==null && !el.disabled && el.id!=='frame'); }
function setFocus(el){ if(focusEl) focusEl.classList.remove('focused'); focusEl=el; el.classList.add('focused'); el.scrollIntoView({block:'nearest', inline:'nearest', behavior:'smooth'}); }
function focusFirst(){ const f=focusables()[0]; if(f) setFocus(f); }
function moveFocus(dir){
  const els = focusables();
  if(!els.length) return;
  if(!focusEl || !document.contains(focusEl)){ setFocus(els[0]); return; }
  const r = focusEl.getBoundingClientRect();
  const cx = r.left+r.width/2, cy = r.top+r.height/2;
  let best=null, bestScore=1e9;
  for(const el of els){
    if(el===focusEl) continue;
    const b=el.getBoundingClientRect();
    const x=b.left+b.width/2, y=b.top+b.height/2;
    const dx=x-cx, dy=y-cy;
    if(dir==='right' && dx<=10) continue;
    if(dir==='left' && dx>=-10) continue;
    if(dir==='down' && dy<=10) continue;
    if(dir==='up' && dy>=10) continue;
    const primary = dir==='left'||dir==='right' ? Math.abs(dx) : Math.abs(dy);
    const secondary = dir==='left'||dir==='right' ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary*2.2;
    if(score<bestScore){ bestScore=score; best=el; }
  }
  if(best) setFocus(best);
}
document.addEventListener('keydown', (e)=>{
  if(e.key==='ArrowRight'){ e.preventDefault(); moveFocus('right'); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); moveFocus('left'); }
  else if(e.key==='ArrowDown'){ e.preventDefault(); moveFocus('down'); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); moveFocus('up'); }
  else if(e.key==='Enter' && focusEl){ e.preventDefault(); focusEl.click(); }
  else if((e.key==='s' || e.key==='S') && playerOpen()){ e.preventDefault(); cycleServer(1); }
  else if((e.key==='l' || e.key==='L') && playerOpen()){ e.preventDefault(); cycleLang(); }
  else if(e.key==='Escape' || e.key==='BrowserBack' || e.key==='Backspace'){ handleBack(); }
  else if(e.key==='F5'){ e.preventDefault(); refreshCurrent(); }
});
function handleBack(){
  if(!$('#dlModal').classList.contains('hidden')){ closeDl(); return; }
  if(playerOpen()){
    try { if(OwnPlayer.back && OwnPlayer.back()) return; } catch {}
    closePlayer(); return;
  }
  if(!$('#setMenu').classList.contains('hidden')){ setMenuHide(); return; }
  if(!$('#searchBar').classList.contains('hidden')){ toggleSearch(false); return; }
  if(state.view==='details' || state.view==='grid'){ loadHome(); return; }
}
window.__aninekoBack = handleBack;
function refreshCurrent(){
  toast('Refreshing live from aniwave…');
  if(playerOpen()) playEpisode(state.currentSlug, state.currentEp);
  else if(state.view==='details') openAnime(state.currentSlug);
  else if(state.view==='grid'){ if(state.gridMode==='mylist') loadMyList(); else loadLatest(); }
  else loadHome(true);
}
function toggleSearch(on){
  $('#searchBar').classList.toggle('hidden', !on);
  if(on){ setMenuHide(); setTimeout(()=>{ $('#searchInput').focus(); },50); }
  notifyNative();
}
/* ---------- display zoom (persisted) ---------- */
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25];
function getZoom(){
  try { const z = parseFloat(localStorage.getItem('anineko.zoom')); if(ZOOMS.includes(z)) return z; } catch {}
  return 0.9;
}
function applyZoom(z){
  $('#app').style.zoom = z;
  try { localStorage.setItem('anineko.zoom', String(z)); } catch {}
  paintZoom();
}
function paintZoom(){
  const z = getZoom();
  $('#zoomRow').innerHTML = ZOOMS.map((v) => `<button data-focusable data-z="${v}" class="${v === z ? 'on' : ''}">${Math.round(v * 100)}%</button>`).join('');
  [...$('#zoomRow').children].forEach((b) => {
    b.onclick = () => applyZoom(+b.dataset.z);
    b.onmouseenter = () => setFocus(b);
  });
}
function setMenuHide(){ $('#setMenu').classList.add('hidden'); }
function toggleSettings(){
  const m = $('#setMenu');
  m.classList.toggle('hidden');
  if(!m.classList.contains('hidden')){
    paintZoom();
    const cur = [...$('#zoomRow').children].find((b) => b.classList.contains('on'));
    if(cur) setFocus(cur);
  }
}

/* ---------- static wiring ---------- */
$$('#nav button').forEach(b=>b.onclick=()=>{
  const v=b.dataset.nav;
  if(v==='home') loadHome(); if(v==='browse') loadBrowse();
  if(v==='latest') loadLatest(); if(v==='mylist') loadMyList(); if(v==='schedule') loadSchedule();
});
$('#searchBtn').onclick=()=>toggleSearch(true);
$('#setBtn').onclick=()=>toggleSettings();
$('#searchClose').onclick=()=>toggleSearch(false);
$('#searchGo').onclick=()=>doSearch($('#searchInput').value.trim());
$('#searchInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.stopPropagation(); doSearch(e.target.value.trim()); } });
$('#refreshBtn').onclick=()=>refreshCurrent();
$('#heroPlay').onclick=()=>{ const s=$('#hero').dataset.slug; if(s) openAnime(s); };
$('#heroInfo').onclick=()=>{ const s=$('#hero').dataset.slug; if(s) openAnime(s); };
$('#heroList').onclick=(e)=>{ e.stopPropagation(); handleAction($('#heroList')); };
$('#hero').onclick=(e)=>{ if(e.target.closest('button')) return; const s=$('#hero').dataset.slug; if(s) openAnime(s); };
$('#dBack').onclick=()=>loadHome();
$('#dPlay').onclick=()=>{
  const c = getContinue()[state.currentSlug];
  playEpisode(state.currentSlug, (c && c.ep) || state.details.episodes[0]?.number || 1);
};
$('#dWatchlist').onclick=()=>{
  const d = state.details;
  const added = toggleList(state.currentSlug, { title: d?.title, poster: d?.poster });
  toast(added ? 'Added to My List' : 'Removed from My List');
  syncListBtn();
};
$('#dShare').onclick=()=>{
  const url = 'https://aniwaves.ru/watch/' + state.currentSlug;  try {
    if(navigator.clipboard) navigator.clipboard.writeText(url).then(
      () => toast('Link copied to clipboard'),
      () => toast(url));
    else toast(url);
  } catch { toast(url); }
};
$('#epPrev').onclick=()=>{ state.epPage=Math.max(0,state.epPage-1); paintEps(); };
$('#epNext').onclick=()=>{ state.epPage++; paintEps(); };
$('#dlStart').onclick=()=>startDownload();
$('#dlCancel').onclick=()=>closeDl();
$('.logo').onclick=()=>loadHome();
$('#bootRetry').onclick=()=>{ $('#bootRetry').classList.add('hidden'); loadHome(true); };

// auto live-refresh every 10 min on home
setInterval(()=>{ if(state.view==='home' && $('#player').classList.contains('hidden')) loadHome(true); }, 10*60*1000);

applyZoom(getZoom());
// TV shell hides download UI; phone shell shows it
try {
  if (window.AniNeko && typeof window.AniNeko.isTV === 'function' && window.AniNeko.isTV()) {
    document.body.classList.add('tv');
  }
} catch {}
loadHome();
