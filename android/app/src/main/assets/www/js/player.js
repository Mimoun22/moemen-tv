/* OwnPlayer — Netflix-style HTML5 player for AniNeko TV (browser mode).
 * HLS via vendored hls.js through the /api/hls proxy (dodges missing CORS).
 * Subtitles = proxied VTT tracks. D-pad fully supported. */
const OwnPlayer = (() => {
  const v = () => $('#v');
  const S = {
    open: false, slug: null, ep: 1, title: '', poster: '',
    servers: { sub: [], dub: [], hsub: [] }, lang: 'dub', srvIdx: 0,
    episodes: [], hls: null, resolved: {}, menu: null, hideTimer: null,
    endTimer: null, speed: 1, subPref: null, lastSave: 0, seeking: false,
    locked: false, subSrc: '',
  };
  try {
    S.speed = parseFloat(localStorage.getItem('anineko.speed')) || 1;
    S.subPref = localStorage.getItem('anineko.subpref');
  } catch {}

  const fmt = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const store = () => {
    try { return JSON.parse(localStorage.getItem('anineko.continue')) || {}; }
    catch { return {}; }
  };
  const savePos = (force) => {
    const el = v();
    if (!S.slug || !el.duration) return;
    const now = Date.now();
    if (!force && now - S.lastSave < 5000) return;
    S.lastSave = now;
    const c = store();
    c[S.slug] = { title: S.title, poster: S.poster, ep: S.ep, pos: el.currentTime, dur: el.duration, at: now };
    try { localStorage.setItem('anineko.continue', JSON.stringify(c)); } catch {}
  };
  const savedPos = () => {
    const c = store()[S.slug];
    if (c && c.ep === S.ep && c.pos > 10 && (!c.dur || c.pos < c.dur - 20)) return c.pos;
    return 0;
  };

  /* ---------- open / close ---------- */
  async function open(opts) {
    Object.assign(S, { slug: opts.slug, ep: opts.ep, title: opts.title || opts.slug,
      poster: opts.poster || '', servers: opts.servers, lang: opts.lang || 'sub',
      episodes: opts.episodes || [], srvIdx: 0, resolved: {}, open: true });
    if (!liveServers(S.lang).length) {
      S.lang = ['dub', 'hsub', 'sub'].find((l) => liveServers(l).length) || 'dub';
    }
    $('#player').classList.remove('hidden');
    $('#player').classList.remove('bars-hidden');
    $('#vEnd').classList.add('hidden');
    closeMenu();
    setLangBtn();
    // DUB embeds carry no VTT: borrow the episode's English VTT so EN + AR tracks exist everywhere
    S.subSrc = '';
    for (const l of ['sub', 'dub', 'hsub']) {
      const hit = ((opts.servers || {})[l] || []).find((s) => /[?&](sub=|caption_1=|c1_file=)/.test(s.embed || ''));
      if (hit) { S.subSrc = hit.embed; break; }
    }
    if (!S.subSrc) {
      // Aniwatch/MegaPlay embeds carry subs server-side: hand the SUB embed to /api/stream as subSrc
      const sub = ((opts.servers || {}).sub || [])[0];
      if (sub && sub.embed) S.subSrc = sub.embed;
    }
    $('#pTitle').textContent = `${S.title} — Episode ${S.ep}`;
    paintBars();
    wireOnce();
    showBars();
    await tryServers(0);
    notifyNative();
  }
  function close() {
    savePos(true);
    destroyHls();
    try { v().pause(); v().removeAttribute('src'); v().load(); } catch {}
    clearTimeout(S.endTimer);
    closeMenu();
    if (S.locked) toggleLock(true);
    $('#player').classList.add('hidden');
    S.open = false;
    notifyNative();
  }
  /** Screen lock: every button disappears, only the lock remains. */
  function toggleLock(force) {
    S.locked = force !== undefined ? !!force : !S.locked;
    $('#player').classList.toggle('locked', S.locked);
    $('#vLockFab').classList.toggle('hidden', !S.locked);
    if (S.locked) {
      closeMenu();
      const f = $('#vLockFab');
      if (window.__focus) window.__focus(f);
      else f.focus();
    } else {
      showBars();
    }
  }
  function notifyNative() {
    try {
      if (window.AniNeko && typeof window.AniNeko.setState === 'function') {
        window.AniNeko.setState(JSON.stringify({ playerOpen: S.open,
          searchOpen: !$('#searchBar').classList.contains('hidden'), view: state.view }));
      }
    } catch {}
  }

  /* ---------- resolving ---------- */
  const proxied = (file, ref) => '/api/hls?url=' + encodeURIComponent(file) + '&ref=' + encodeURIComponent(ref || '');
  async function resolve(idx) {
    const list = liveServers();
    const srv = list[idx];
    if (!srv) throw new Error('no server');
    if (S.resolved[srv.embed]) return { ...S.resolved[srv.embed], name: srv.name };
    let url = '/api/stream?embed=' + encodeURIComponent(srv.embed);
    if (S.subSrc && S.subSrc !== srv.embed) url += '&subSrc=' + encodeURIComponent(S.subSrc);
    const d = await api(url);
    if (!d.playable) { const err = new Error('site-player only'); err.embedOnly = true; throw err; }
    const out = { file: proxied(d.file, d.referer), type: d.type, name: srv.name,
      tracks: d.tracks || [], poster: d.poster || S.poster, duration: d.duration || 0 };
    S.resolved[srv.embed] = out;
    return out;
  }
  // Aniwatch server names (VidSrc, HD-1, …) all resolve through MegaPlay — no exclusions.
  const liveServers = (lang) => ((S.servers[lang || S.lang]) || []).filter((s) => s && s.embed);
  function availLangs() { return ['dub', 'hsub', 'sub'].filter((l) => liveServers(l).length); }
  async function tryServers(startIdx) {
    const list = liveServers();
    for (let i = startIdx; i < list.length; i++) {
      try {
        toast(`Loading ${list[i].name}…`);
        await loadAt(i, 'saved');
        return;
      } catch (e) { /* try next */ }
    }
    // nothing playable on this language
    showError(`No direct stream on ${S.lang.toUpperCase()}.`, true);
  }
  async function loadAt(idx, mode) {
    // mode 'saved' = fresh open (use stored position, ignore stale video time)
    // mode 'current' = server switch (keep playing position)
    // number = explicit seconds
    let resume = 0;
    if (mode === 'current') resume = v().currentTime || 0;
    else if (typeof mode === 'number') resume = mode;
    if (!(resume > 10)) resume = savedPos();
    const r = await resolve(idx);
    S.srvIdx = idx;
    destroyHls();
    const el = v();
    // subtitles
    [...el.querySelectorAll('track')].forEach((t) => t.remove());
    (r.tracks || []).forEach((t, i) => {
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = t.label || ('English ' + (i + 1)); tr.srclang = 'en'; tr.src = t.file;
      el.appendChild(tr);
    });
    applySubPref();
    el.poster = r.poster || '';
    el.playbackRate = S.speed;
    $('#vSpin').classList.remove('hidden');
    if (r.type === 'hls' && window.Hls && Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 60, backBufferLength: 30 });
      S.hls = h;
      h.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          destroyHls();
          const list = liveServers();
          if (S.srvIdx + 1 < list.length) { toast(`Server failed — trying ${list[S.srvIdx + 1].name}…`); tryServers(S.srvIdx + 1); }
          else showError('This stream failed on every server.', true);
        }
      });
      h.loadSource(r.file);
      h.attachMedia(el);
      h.on(Hls.Events.MANIFEST_PARSED, () => startPlayback(resume));
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = r.file; // Safari native HLS
      el.onloadedmetadata = () => startPlayback(resume);
    } else {
      el.src = r.file;
      el.onloadedmetadata = () => startPlayback(resume);
    }
    el.onerror = () => {
      const list = liveServers();
      if (S.srvIdx + 1 < list.length) { toast(`Server failed — trying ${list[S.srvIdx + 1].name}…`); tryServers(S.srvIdx + 1); }
      else showError('This stream failed on every server.', true);
    };
    setServerBtn();
    paintBars();
  }
  function startPlayback(resume) {
    const el = v();
    $('#vSpin').classList.add('hidden');
    if (resume > 10) { try { el.currentTime = resume; } catch {} toast('Resumed at ' + fmt(resume)); }
    el.play().catch(() => paintBars());
  }
  function destroyHls() { try { S.hls && S.hls.destroy(); } catch {} S.hls = null; }

  /* ---------- transport ---------- */
  function toggle() { const el = v(); el.paused ? el.play().catch(() => {}) : el.pause(); paintBars(); activity(); }
  function seek(d) {
    const el = v();
    if (!isFinite(el.duration)) return;
    el.currentTime = Math.min(Math.max(0, el.currentTime + d), el.duration);
    flash(d); paintBars(); activity(); savePos(true);
  }
  function flash(d) {
    const f = $(d < 0 ? '#vFlashL' : '#vFlashR');
    f.textContent = (d < 0 ? '−' : '+') + Math.abs(d) + 's';
    f.classList.add('show');
    clearTimeout(f._h); f._h = setTimeout(() => f.classList.remove('show'), 450);
  }
  function setSpeed(r) {
    S.speed = r; v().playbackRate = r;
    try { localStorage.setItem('anineko.speed', String(r)); } catch {}
    $('#bSpeed').textContent = (r + 'x').replace('.0x', 'x').replace('0.', '.');
    toast('Speed ' + r + 'x');
  }
  async function cycleLang() {
    const av = availLangs();
    if (av.length < 2) { toast('Only ' + (av[0] || '—').toUpperCase()); return; }
    S.lang = av[(av.indexOf(S.lang) + 1) % av.length];
    setLangBtn();
    toast('Audio: ' + S.lang.toUpperCase());
    await tryServers(0);
  }
  function cycleServer(d = 1) {
    const list = liveServers();
    if (!list.length) return;
    loadAt((S.srvIdx + d + list.length) % list.length, 'current').catch(() => showError('Server switch failed.', true));
  }
  function setLangBtn() { $('#bLang').textContent = (S.lang || 'sub').toUpperCase(); }
  function setServerBtn() {
    const list = liveServers();
    $('#bServer').textContent = '▦ ' + ((list[S.srvIdx] || {}).name || ('Server ' + (S.srvIdx + 1)));
  }

  /* ---------- subtitles ---------- */
  function textTracks() { return [...v().textTracks || []]; }
  function applySubPref() {
    const tracks = textTracks();
    if (!tracks.length) return;
    let want = S.subPref;
    // DUB starts clean (opt-in via CC); SUB auto-shows like before
    if ((want === null || want === undefined) && S.lang === 'dub') {
      tracks.forEach((t) => (t.mode = 'disabled'));
      return;
    }
    if (want === 'off') { tracks.forEach((t) => (t.mode = 'disabled')); return; }
    let pick = tracks.find((t) => t.label === want) || tracks[0];
    tracks.forEach((t) => (t.mode = t === pick ? 'showing' : 'disabled'));
  }
  function cycleSubs() {
    const tracks = textTracks();
    const showing = tracks.findIndex((t) => t.mode === 'showing');
    const next = showing + 1;
    if (next >= tracks.length) {
      tracks.forEach((t) => (t.mode = 'disabled'));
      S.subPref = 'off'; toast('Subtitles off');
    } else {
      tracks.forEach((t, i) => (t.mode = i === next ? 'showing' : 'disabled'));
      S.subPref = tracks[next].label; toast('Subtitles: ' + tracks[next].label);
    }
    try { localStorage.setItem('anineko.subpref', S.subPref || ''); } catch {}
    paintBars();
  }

  /* ---------- menus ---------- */
  function openMenu(title, items, onPick, current) {
    S.menu = { onPick };
    $('#vMenuTitle').textContent = title;
    $('#vMenuList').innerHTML = items.map((t, i) =>
      `<button data-focusable data-mi="${i}">${esc(t)}${t === current ? '<span class="tick">✓</span>' : ''}</button>`).join('');
    [...$('#vMenuList').children].forEach((b) => {
      b.onclick = () => { const i = +b.dataset.mi; closeMenu(); onPick(i); };
      b.onmouseenter = () => window.__focus && window.__focus(b);
    });
    $('#vMenu').classList.remove('hidden');
    showBars(true);
    const first = $('#vMenuList').children[0];
    if (first && window.__focus) window.__focus(first);
  }
  function closeMenu() { S.menu = null; $('#vMenu').classList.add('hidden'); }

  function menuSpeed() {
    openMenu('PLAYBACK SPEED', ['0.5x', '0.75x', '1x', '1.25x', '1.5x', '1.75x', '2x'],
      (i) => setSpeed([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2][i]), S.speed + 'x');
  }
  function menuSubs() {
    const tracks = textTracks();
    const items = ['Off', ...tracks.map((t) => t.label)];
    const cur = tracks.findIndex((t) => t.mode === 'showing');
    openMenu('SUBTITLES', items, (i) => {
      if (i === 0) { tracks.forEach((t) => (t.mode = 'disabled')); S.subPref = 'off'; toast('Subtitles off'); }
      else { tracks.forEach((t, j) => (t.mode = j === i - 1 ? 'showing' : 'disabled')); S.subPref = tracks[i - 1].label; toast('Subtitles: ' + S.subPref); }
      try { localStorage.setItem('anineko.subpref', S.subPref || ''); } catch {}
      paintBars();
    }, cur < 0 ? 'Off' : tracks[cur].label);
  }
  function menuServers() {
    const list = liveServers();
    openMenu((S.lang || '').toUpperCase() + ' SERVERS', list.map((s, i) => `${i + 1}. ${s.name}`),
      (i) => loadAt(i, 'current').catch(() => showError('Server switch failed.', true)),
      `${S.srvIdx + 1}. ${(list[S.srvIdx] || {}).name}`);
  }
  function menuLang() {
    const av = availLangs();
    openMenu('AUDIO', av.map((l) => l.toUpperCase()), async (i) => {
      S.lang = av[i]; setLangBtn(); await tryServers(0);
    }, S.lang.toUpperCase());
  }
  function menuQuality() {
    const h = S.hls;
    if (!h || !h.levels || !h.levels.length) { toast('Quality: auto only for this stream'); return; }
    const items = ['Auto', ...h.levels.map((l) => (l.height ? l.height + 'p' : (l.bitrate / 1000 | 0) + 'kbps'))];
    const cur = h.autoLevelEnabled ? 'Auto' : items[h.currentLevel + 1];
    openMenu('QUALITY', items, (i) => {
      if (i === 0) { h.currentLevel = -1; $('#bQual').textContent = 'Auto'; }
      else { h.currentLevel = i - 1; $('#bQual').textContent = items[i]; }
      toast('Quality: ' + items[i]);
    }, cur);
  }

  /* ---------- error / ended ---------- */
  function showError(msg, canFallback) {
    $('#vSpin').classList.add('hidden');
    const box = $('#vEnd');
    const list = liveServers();
    box.innerHTML = `<h2>Couldn't play this stream</h2><p>${esc(msg)}</p>
      <div class="row">
        <button data-focusable data-ea="retry" class="primary">↻ Retry</button>
        ${canFallback ? '<button data-focusable data-ea="site">▸ Site player</button>' : ''}
        <button data-focusable data-ea="back">← Back</button>
      </div>`;
    box.classList.remove('hidden');
    showBars(true);
    [...box.querySelectorAll('button')].forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.ea;
        box.classList.add('hidden');
        if (a === 'retry') tryServers(0);
        else if (a === 'site') openFrameFallback();
        else close();
      };
      b.onmouseenter = () => window.__focus && window.__focus(b);
    });
    if (window.__focus) window.__focus(box.querySelector('[data-ea="retry"]'));
  }
  function onEnded() {
    savePos(true);
    const next = S.ep + 1;
    const hasNext = S.episodes.includes(next);
    const box = $('#vEnd');
    if (!hasNext) {
      box.innerHTML = `<h2>Thanks for watching</h2><p>${esc(S.title)}</p>
        <div class="row"><button data-focusable data-ea="back" class="primary">← Back to details</button></div>`;
      box.classList.remove('hidden');
      const b = box.querySelector('button');
      b.onclick = () => close();
      if (window.__focus) window.__focus(b);
      return;
    }
    let n = 10;
    box.innerHTML = `<h2>Up next: Episode ${next}</h2><p>Starting in <b id="vCount">${n}</b>s — OK plays now, Back cancels</p>
      <div class="row"><button data-focusable data-ea="now" class="primary">▶ Play now</button>
      <button data-focusable data-ea="back">✕ Cancel</button></div>`;
    box.classList.remove('hidden');
    showBars(true);
    const tick = () => {
      n--;
      const c = $('#vCount');
      if (!c) return;
      if (n <= 0) { window.__playEp && window.__playEp(S.slug, next); return; }
      c.textContent = n;
      S.endTimer = setTimeout(tick, 1000);
    };
    S.endTimer = setTimeout(tick, 1000);
    [...box.querySelectorAll('button')].forEach((b) => {
      b.onclick = () => {
        clearTimeout(S.endTimer);
        if (b.dataset.ea === 'now') window.__playEp && window.__playEp(S.slug, next);
        else { box.classList.add('hidden'); }
      };
      b.onmouseenter = () => window.__focus && window.__focus(b);
    });
    if (window.__focus) window.__focus(box.querySelector('[data-ea="now"]'));
  }

  /* ---------- site iframe fallback ---------- */
  function openFrameFallback() {
    const list = liveServers();
    $('#vFrameWrap').classList.remove('hidden');
    $('#serverRow').innerHTML = list.map((s, i) =>
      `<button data-focusable data-srv="${i}" class="${i === S.srvIdx ? 'on' : ''}"><b>${i + 1}</b>${esc(s.name)}</button>`).join('');
    [...$('#serverRow').children].forEach((b) => {
      b.onclick = () => {
        [...$('#serverRow').children].forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        $('#frame').src = list[+b.dataset.srv].embed;
      };
      b.onmouseenter = () => window.__focus && window.__focus(b);
    });
    if (list[S.srvIdx]) $('#frame').src = list[S.srvIdx].embed;
    const f = $('#serverRow').children[0];
    if (f && window.__focus) window.__focus(f);
  }
  function closeFrame() { $('#vFrameWrap').classList.add('hidden'); try { $('#frame').src = 'about:blank'; } catch {} }

  /* ---------- bars / progress ---------- */
  function hideBars() {
    clearTimeout(S.hideTimer);
    $('#player').classList.add('bars-hidden');
  }
  function showBars(sticky) {    $('#player').classList.remove('bars-hidden');
    clearTimeout(S.hideTimer);
    if (!sticky && !v().paused && !S.menu) {
      S.hideTimer = setTimeout(() => {
        if (!S.menu && !v().paused && $('#vFrameWrap').classList.contains('hidden')
            && $('#vEnd').classList.contains('hidden')) {
          $('#player').classList.add('bars-hidden');
        }
      }, 4000);
    }
  }
  function activity() { showBars(); }
  function paintBars() {
    const el = v();
    $('#bPlay').textContent = el.paused ? '▶' : '❚❚';
    $('#vCur').textContent = fmt(el.currentTime);
    $('#vDur').textContent = fmt(el.duration);
    const pct = el.duration ? (el.currentTime / el.duration) * 100 : 0;
    $('#vPlayed').style.width = pct + '%';
    $('#vKnob').style.left = pct + '%';
    const tip = $('#vTip');
    if (tip) { tip.style.left = pct + '%'; tip.textContent = fmt(el.currentTime); }
    try {
      if (el.buffered.length) {
        $('#vBuf').style.width = ((el.buffered.end(el.buffered.length - 1) / el.duration) * 100 || 0) + '%';
      }
    } catch {}
    setServerBtn();
  }

  /* ---------- wiring (once) ---------- */
  let wired = false;
  function wireOnce() {
    if (wired) return;
    wired = true;
    const el = v();
    el.addEventListener('timeupdate', () => { paintBars(); savePos(false); });
    el.addEventListener('progress', paintBars);
    el.addEventListener('play', () => { paintBars(); activity(); $('#vBig').classList.add('hidden'); });
    el.addEventListener('pause', () => { paintBars(); showBars(true); savePos(true); });
    el.addEventListener('waiting', () => $('#vSpin').classList.remove('hidden'));
    el.addEventListener('playing', () => $('#vSpin').classList.add('hidden'));
    el.addEventListener('ended', onEnded);
    el.addEventListener('click', () => {
      // YouTube-style: tapping the video toggles the controls (never playback)
      if (S.locked || S.menu) return;
      if ($('#player').classList.contains('bars-hidden')) showBars();
      else hideBars();
    });
    $('#bPlay').onclick = toggle;
    $('#bBack10').onclick = () => seek(-10);
    $('#bFwd10').onclick = () => seek(10);
    $('#bPrevEp').onclick = () => window.__playEp && window.__playEp(S.slug, S.ep - 1);
    $('#bNextEp').onclick = () => window.__playEp && window.__playEp(S.slug, S.ep + 1);
    $('#pPrev').onclick = () => window.__playEp && window.__playEp(S.slug, S.ep - 1);
    $('#pNext').onclick = () => window.__playEp && window.__playEp(S.slug, S.ep + 1);
    $('#pBack').onclick = () => close();
    $('#bLang').onclick = menuLang;
    $('#bServer').onclick = menuServers;
    $('#bSubs').onclick = menuSubs;
    $('#bSpeed').onclick = menuSpeed;
    $('#bQual').onclick = menuQuality;
    $('#bLock').onclick = () => toggleLock();
    $('#vLockFab').onclick = () => toggleLock();
    $('#bSite').onclick = openFrameFallback;
    $('#bFull').onclick = () => {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      } catch {}
    };
    $('#bFrameClose').onclick = closeFrame;
    // seek bar: mouse/touch
    const prog = $('#vProg');
    const seekTo = (clientX) => {
      const r = prog.getBoundingClientRect();
      const ratio = Math.min(Math.max(0, (clientX - r.left) / r.width), 1);
      if (isFinite(el.duration)) { el.currentTime = ratio * el.duration; paintBars(); savePos(true); }
    };
    prog.addEventListener('pointerdown', (e) => { S.seeking = true; prog.setPointerCapture(e.pointerId); seekTo(e.clientX); });
    prog.addEventListener('pointermove', (e) => { if (S.seeking) seekTo(e.clientX); });
    prog.addEventListener('pointerup', () => (S.seeking = false));
    document.addEventListener('mousemove', () => { if (S.open) activity(); });
    // capture-phase remote keys: first press reveals bars (Netflix-style), menu Esc, prog arrows
    document.addEventListener('keydown', (e) => {
      if (!S.open) return;
      if (e.key === 'Escape' || e.key === 'BrowserBack') {
        if (S.menu) { e.stopPropagation(); e.preventDefault(); closeMenu(); paintBars(); }
        else if (!$('#vFrameWrap').classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); closeFrame(); }
        return;
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // locked: swallow everything; Esc/Back still bubbles up to unlock
      if (S.locked) {
        if (e.key !== 'Escape' && e.key !== 'BrowserBack' && e.key !== 'Backspace') {
          e.stopPropagation(); e.preventDefault();
        }
        return;
      }
      if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.stopPropagation(); e.preventDefault(); toggle(); }
      else if (e.key.toLowerCase() === 'f') { $('#bFull').click(); }
      else if (e.key.toLowerCase() === 'm') { el.muted = !el.muted; toast(el.muted ? 'Muted' : 'Unmuted'); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (document.activeElement === prog || $('#player').classList.contains('bars-hidden')) {
          e.stopPropagation(); e.preventDefault();
          activity();
          seek(e.key === 'ArrowLeft' ? -10 : 10);
        } else activity();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter') {
        activity();
        if ($('#player').classList.contains('bars-hidden')) {
          e.stopPropagation(); e.preventDefault();
          if (e.key === 'Enter') toggle(); // pause works on FIRST press
        }
      }
    }, true);
  }

  return { open, close, toggle, seek, cycleServer, cycleLang, cycleSubs, menuServers,
    menuLang, menuSubs, menuSpeed, menuQuality, toggleLock, hideBars,
    get isOpen() { return S.open; }, get state() { return S; }, activity,
    back() {
      if (S.locked) { toggleLock(false); return true; }
      if (S.menu) { closeMenu(); return true; }
      if (!$('#vFrameWrap').classList.contains('hidden')) { closeFrame(); return true; }
      return false;
    } };
})();
