// Wingly web client — a small hash-routed SPA with no build step.
const app = document.getElementById('app');
let me = null; // { id, username, isAdmin }
let ai = { configured: false };
let teardown = null; // cleanup for the current view (player timers, polling)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0');
};
const mins = (s) => (s ? `${Math.max(1, Math.round(s / 60))} min` : '');
const epCode = (i) => `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'X-Wingly': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) { me = null; boot(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── cards ─────────────────────────────────────────────────────────────────────
function itemCard(i) {
  const pct = i.duration && i.position ? Math.min(100, (i.position / i.duration) * 100) : 0;
  const title = i.kind === 'episode' ? i.showTitle : i.title;
  const sub = i.kind === 'episode' ? `${epCode(i)} · ${i.title}` : [i.year, mins(i.duration)].filter(Boolean).join(' · ');
  return `<a class="card" href="#/item/${i.id}">
    <div class="thumb"><img loading="lazy" alt="" src="/api/items/${i.id}/thumb">
      ${i.watched ? '<span class="badge">✓ Watched</span>' : ''}${pct ? `<span class="bar" style="width:${pct}%"></span>` : ''}</div>
    <div class="t">${esc(title)}</div><div class="s">${esc(sub) || '&nbsp;'}</div></a>`;
}
function showCard(s) {
  return `<a class="card" href="#/show/${s.id}">
    <div class="thumb"><img loading="lazy" alt="" src="/api/shows/${s.id}/thumb"></div>
    <div class="t">${esc(s.title)}</div>
    <div class="s">${[s.year, s.episodes ? `${s.episodes} episode${s.episodes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div></a>`;
}
const grid = (cards, empty) => (cards.length ? `<div class="grid">${cards.join('')}</div>` : `<div class="empty">${empty}</div>`);

// ── shell ─────────────────────────────────────────────────────────────────────
function shell(active, html) {
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  app.innerHTML = `
    <header class="top">
      <a class="brand" href="#/"><img src="/logo.svg" alt="">Wingly</a>
      <nav>${link('#/', 'Home', 'home')}${link('#/movies', 'Movies', 'movies')}${link('#/shows', 'Shows', 'shows')}
        ${link('#/ask', '✨ Ask', 'ask')}${me.isAdmin ? link('#/settings', 'Settings', 'settings') : ''}</nav>
      <form id="search"><input name="q" type="search" placeholder="Search library…" aria-label="Search"></form>
      <button class="btn link" id="logout" title="Signed in as ${esc(me.username)}">Sign out</button>
    </header><main>${html}</main>`;
  app.querySelector('#search').onsubmit = (e) => {
    e.preventDefault();
    location.hash = '#/search/' + encodeURIComponent(e.target.q.value.trim());
  };
  app.querySelector('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; boot(); };
}

// ── views ─────────────────────────────────────────────────────────────────────
const views = {
  async home() {
    const d = await api('/home');
    if (!d.counts.libraries) {
      return shell('home', `<div class="empty"><h1>Welcome to Wingly</h1>
        <p>${me.isAdmin ? 'Point Wingly at a folder of movies or shows to get started.' : 'No libraries yet — ask your admin to add one.'}</p>
        ${me.isAdmin ? '<a class="btn primary" href="#/settings">Add a library</a>' : ''}</div>`);
    }
    shell('home', `
      ${d.continueWatching.length ? `<h2>Continue watching</h2>${grid(d.continueWatching.map(itemCard))}` : ''}
      <h2>Recently added movies</h2>${grid(d.recentMovies.map(itemCard), 'No movies yet.')}
      <h2>Recently added shows</h2>${grid(d.recentShows.map(showCard), 'No shows yet.')}`);
  },
  async movies() {
    const list = await api('/movies');
    shell('movies', `<h1>Movies</h1><p class="muted">${list.length} title${list.length === 1 ? '' : 's'}</p>${grid(list.map(itemCard), 'No movies yet.')}`);
  },
  async shows() {
    const list = await api('/shows');
    shell('shows', `<h1>Shows</h1><p class="muted">${list.length} series</p>${grid(list.map(showCard), 'No shows yet.')}`);
  },
  async search(q) {
    q = decodeURIComponent(q || '');
    const d = await api('/search?q=' + encodeURIComponent(q));
    shell('', `<h1>Results for “${esc(q)}”</h1>
      ${grid([...d.movies.map(itemCard), ...d.shows.map(showCard)], `Nothing matches. ${ai.configured ? 'Try <a href="#/ask"><u>asking the AI</u></a> — it understands descriptions, not just titles.' : ''}`)}`);
    app.querySelector('#search input').value = q;
  },
  async show(id) {
    const s = await api('/shows/' + id);
    const seasons = new Map();
    for (const e of s.episodes) (seasons.get(e.season) || seasons.set(e.season, []).get(e.season)).push(e);
    const up = s.episodes.find((e) => !e.watched) || s.episodes[0];
    shell('shows', `<div class="hero">
      <div class="thumb"><img alt="" src="/api/shows/${s.id}/thumb"></div>
      <div><h1>${esc(s.title)}</h1>
        <div class="muted">${[s.year, `${s.episodes.length} episodes`].filter(Boolean).join(' · ')}</div>
        <div class="chips">${s.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>
        <p>${esc(s.overview) || '<span class="muted">No description yet.</span>'}</p>
        ${s.aiEnriched && s.overview ? '<p class="muted small">Description written by your AI — may contain mistakes.</p>' : ''}
        <div class="actions">${up ? `<a class="btn primary" href="#/play/${up.id}">▶ Play ${epCode(up)}</a>` : ''}</div>
      </div></div>
      ${[...seasons].map(([n, eps]) => `<h2>${n === 0 ? 'Specials' : 'Season ' + n}</h2><div class="eps">${eps.map((e) => `
        <a class="ep" href="#/play/${e.id}"><span class="n">${e.episode}</span><span>${esc(e.title)}</span>
        <span class="muted small">${e.watched ? '✓ ' : e.position ? clock(e.position) + ' / ' : ''}${mins(e.duration)}</span></a>`).join('')}</div>`).join('')}`);
  },
  async item(id) {
    const i = await api('/items/' + id);
    const res = i.height ? `${i.height}p` : '';
    shell(i.kind === 'movie' ? 'movies' : 'shows', `<div class="hero">
      <div class="thumb"><img alt="" src="/api/items/${i.id}/thumb"></div>
      <div>
        ${i.kind === 'episode' ? `<a class="muted" href="#/show/${i.showId}">${esc(i.showTitle)} · ${epCode(i)}</a>` : ''}
        <h1>${esc(i.title)}</h1>
        <div class="muted">${[i.year, mins(i.duration), res, i.videoCodec, i.audioCodec].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="chips">${i.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>
        <p>${esc(i.overview) || ''}</p>
        ${i.aiEnriched && i.overview ? '<p class="muted small">Description written by your AI — may contain mistakes.</p>' : ''}
        <div class="actions">
          <a class="btn primary" href="#/play/${i.id}">▶ ${i.position > 30 ? 'Resume at ' + clock(i.position) : 'Play'}</a>
          ${i.position > 30 ? `<button class="btn" id="restart">Start over</button>` : ''}
          <button class="btn" id="mark">${i.watched ? 'Mark unwatched' : 'Mark watched'}</button>
        </div>
        <p class="muted small">${esc(i.file)} · ${(i.size / 1e9).toFixed(2)} GB · ${i.playback.mode === 'direct' ? 'Direct play' : `Converted on the fly (video: ${i.playback.video}, audio: ${i.playback.audio})`}</p>
      </div></div>`);
    app.querySelector('#mark').onclick = async () => {
      await api(`/items/${i.id}/progress`, { method: 'PUT', body: { position: 0, watched: !i.watched } });
      views.item(id);
    };
    const restart = app.querySelector('#restart');
    if (restart) restart.onclick = async () => {
      await api(`/items/${i.id}/progress`, { method: 'PUT', body: { position: 0, watched: false } });
      location.hash = '#/play/' + i.id;
    };
  },
  play: (id) => player(id),
  ask: () => askView(),
  settings: () => settingsView(),
};

// ── player ────────────────────────────────────────────────────────────────────
async function player(id) {
  const item = await api('/items/' + id);
  const transcoding = item.playback.mode !== 'direct';
  const total = item.duration || 0;
  let offset = 0; // where the current transcode stream starts, in seconds
  const heading = item.kind === 'episode' ? `${item.showTitle} · ${epCode(item)} · ${item.title}` : item.title;

  app.innerHTML = `<div class="player">
    <video playsinline></video>
    <div class="hud topbar"><button class="pbtn" id="back" aria-label="Back">←</button><strong>${esc(heading)}</strong></div>
    <div class="hud ctl">
      <button class="pbtn" id="pp" aria-label="Play or pause">▶</button>
      <span class="time" id="cur">0:00</span>
      <input type="range" id="seek" min="0" max="${Math.max(1, Math.floor(total))}" step="1" value="0" aria-label="Seek">
      <span class="time">${clock(total)}</span>
      ${item.subtitles.length ? `<select id="cc" aria-label="Subtitles"><option value="">Subtitles off</option>${item.subtitles.map((s) => `<option value="${s.n}">${esc(s.label || s.lang)}</option>`).join('')}</select>` : ''}
      <button class="pbtn" id="mute" aria-label="Mute">🔊</button>
      <button class="pbtn" id="fs" aria-label="Fullscreen">⛶</button>
    </div></div>`;
  const root = app.querySelector('.player');
  const video = root.querySelector('video');
  const seek = root.querySelector('#seek');
  const cur = root.querySelector('#cur');
  const cc = root.querySelector('#cc');
  const now = () => offset + video.currentTime;
  let dragging = false;

  function loadSubs() {
    video.querySelectorAll('track').forEach((t) => t.remove());
    if (!cc || cc.value === '') return;
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.src = `/api/items/${id}/subs/${cc.value}?start=${offset}`;
    t.default = true;
    video.append(t);
    t.track.mode = 'showing';
  }
  function goTo(t, autoplay = true) {
    t = Math.max(0, Math.min(t, Math.max(0, total - 2)));
    if (transcoding) {
      offset = t;
      video.src = `/api/items/${id}/transcode?start=${t}`;
      loadSubs();
    } else {
      if (!video.src) video.src = `/api/items/${id}/stream`;
      video.currentTime = t;
    }
    if (autoplay) video.play().catch(() => {}); // autoplay may be blocked: the play button still works
  }
  const save = (extra = {}) => api(`/items/${id}/progress`, { method: 'PUT', body: { position: now(), ...extra } }).catch(() => {});

  video.ontimeupdate = () => {
    if (dragging) return;
    seek.value = now();
    cur.textContent = clock(now());
  };
  video.onplay = video.onpause = () => { root.querySelector('#pp').textContent = video.paused ? '▶' : '⏸'; };
  video.onerror = () => {
    if (!root.querySelector('.note')) root.insertAdjacentHTML('beforeend', '<div class="note">This file could not be played in your browser.</div>');
  };
  video.onended = async () => {
    await save({ watched: true });
    location.hash = item.next ? '#/play/' + item.next.id : '#/item/' + id;
  };
  seek.oninput = () => { dragging = true; cur.textContent = clock(seek.value); };
  seek.onchange = () => { dragging = false; goTo(Number(seek.value)); };
  const toggle = () => (video.paused ? video.play() : video.pause());
  root.querySelector('#pp').onclick = toggle;
  video.onclick = toggle;
  root.querySelector('#mute').onclick = (e) => { video.muted = !video.muted; e.target.textContent = video.muted ? '🔇' : '🔊'; };
  root.querySelector('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.());
  root.querySelector('#back').onclick = () => { location.hash = item.kind === 'episode' ? '#/show/' + item.showId : '#/item/' + id; };
  if (cc) cc.onchange = loadSubs;

  let idle;
  const wake = () => {
    root.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => !video.paused && root.classList.add('idle'), 3000);
  };
  root.onmousemove = root.ontouchstart = wake;
  const keys = (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') goTo(now() + 10, !video.paused);
    else if (e.key === 'ArrowLeft') goTo(now() - 10, !video.paused);
    else if (e.key === 'f') root.querySelector('#fs').click();
    else if (e.key === 'Escape' && !document.fullscreenElement) root.querySelector('#back').click();
    wake();
  };
  document.addEventListener('keydown', keys);
  const timer = setInterval(() => !video.paused && save(), 10000);
  teardown = () => {
    clearInterval(timer);
    clearTimeout(idle);
    document.removeEventListener('keydown', keys);
    if (video.currentTime > 0 && !video.ended) save();
    video.removeAttribute('src');
    video.load(); // stops the download (and the server-side ffmpeg)
  };
  goTo(item.watched ? 0 : item.position || 0);
}

// ── ask the AI ────────────────────────────────────────────────────────────────
const chat = []; // [{ role, content, picks }], kept for the life of the tab

function askView() {
  if (!ai.configured) {
    return shell('ask', `<div class="empty"><h1>✨ Ask your library</h1>
      <p>Connect your own AI — Claude, OpenAI, or a local model through Ollama — and ask things like<br>
      <em>“something funny under two hours I haven’t seen”</em>.</p>
      ${me.isAdmin ? '<a class="btn primary" href="#/settings">Connect an AI</a>' : '<p>Ask your admin to connect one in Settings.</p>'}</div>`);
  }
  const ideas = ['What should I watch tonight?', 'A feel-good movie under two hours', 'Which shows have I not finished?', 'Something like a slow-burn thriller'];
  const bubbles = () => chat.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'ai'}">${esc(m.content)}${
    m.picks?.length ? `<div class="grid">${m.picks.map((p) => (p.type === 'movie'
      ? itemCard({ ...p, kind: 'movie' }) : showCard(p))).join('')}</div>` : ''}</div>`).join('');
  shell('ask', `<div class="chat"><h1>✨ Ask your library</h1>
    <p class="muted">Answered by ${esc(ai.provider)}${ai.model ? ' · ' + esc(ai.model) : ''}. Your library's title list is sent to that provider with each question.</p>
    <div id="log">${bubbles()}</div>
    ${chat.length ? '' : `<div class="suggest">${ideas.map((q) => `<button class="btn" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
    <form class="ask"><input name="q" placeholder="Describe what you feel like watching…" autocomplete="off" required><button class="btn primary">Ask</button></form></div>`);
  const form = app.querySelector('form.ask');
  const send = async (q) => {
    const history = chat.map(({ role, content }) => ({ role, content }));
    chat.push({ role: 'user', content: q });
    app.querySelector('.suggest')?.remove();
    app.querySelector('#log').innerHTML = bubbles() + '<div class="bubble ai muted" id="wait">Thinking…</div>';
    form.q.value = '';
    form.querySelector('button').disabled = true;
    window.scrollTo(0, document.body.scrollHeight);
    try {
      const r = await api('/ai/ask', { method: 'POST', body: { question: q, history } });
      chat.push({ role: 'assistant', content: r.reply, picks: r.picks });
    } catch (e) {
      chat.pop();
      app.querySelector('#wait').outerHTML = `<div class="bubble ai msg err">${esc(e.message)}</div>`;
      form.q.value = q;
      form.querySelector('button').disabled = false;
      return;
    }
    if (location.hash.startsWith('#/ask')) askView();
  };
  form.onsubmit = (e) => { e.preventDefault(); send(form.q.value.trim()); };
  app.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => send(b.dataset.q)));
  form.q.focus();
}

// ── settings (admin) ──────────────────────────────────────────────────────────
const PROVIDER_INFO = {
  anthropic: { label: 'Claude (Anthropic API)', key: true, url: false, model: 'claude-opus-5-5', hint: 'Needs an API key from the Claude Console. Leave the model empty for the default.' },
  openai: { label: 'OpenAI', key: true, url: false, model: 'model name', hint: 'Needs an OpenAI API key and the name of a chat model.' },
  ollama: { label: 'Ollama (local, free)', key: false, url: true, model: 'e.g. llama3.1', hint: 'Runs on your own hardware. Base URL defaults to http://localhost:11434/v1.' },
  'openai-compatible': { label: 'Other (OpenAI-compatible)', key: true, url: true, model: 'model name', hint: 'LM Studio, OpenRouter, Groq, Gemini’s compatible endpoint, llama.cpp… Enter its base URL (ending in /v1).' },
};

async function settingsView() {
  if (!me.isAdmin) return void (location.hash = '#/');
  const [st, cfg] = await Promise.all([api('/admin/state'), api('/settings/ai')]);
  ai = cfg;
  const provider = cfg.provider || '';
  shell('settings', `<h1>Settings</h1>
    <div class="panel"><h2>Libraries</h2>
      <div class="list">${st.libraries.map((l) => `<div><span><strong>${esc(l.name)}</strong> <span class="chip">${l.type === 'movie' ? 'Movies' : 'Shows'}</span> <span class="muted small">${l.items} files</span><br><code>${esc(l.path)}</code></span>
        <button class="btn danger" data-del-lib="${l.id}" data-name="${esc(l.name)}">Remove</button></div>`).join('') || '<div class="muted">No libraries yet.</div>'}</div>
      <form class="row" id="addlib"><input name="name" placeholder="Name (e.g. Movies)" required>
        <select name="type"><option value="movie">Movies</option><option value="show">TV shows</option></select>
        <input name="path" placeholder="Folder on the server, e.g. /media/movies" required><button class="btn primary">Add library</button></form>
      <div class="row"><button class="btn" id="scan">Scan now</button><span class="muted small" id="scanmsg"></span></div>
      <div class="msg err" id="liberr"></div></div>

    <div class="panel"><h2>✨ Your AI</h2>
      <p class="muted small">Wingly has no AI of its own and no subscription. Plug in a provider you already pay for, or a free local model. The key stays on this server.</p>
      <form id="ai"><div class="row">
        <select name="provider"><option value="">Off</option>${cfg.providers.map((p) => `<option value="${p}" ${p === provider ? 'selected' : ''}>${PROVIDER_INFO[p].label}</option>`).join('')}</select>
        <input name="model" placeholder="Model" value="${esc(provider ? (cfg.model === 'claude-opus-5-5' && provider === 'anthropic' ? '' : cfg.model) : '')}">
        </div><div class="row">
        <input name="apiKey" type="password" autocomplete="off" placeholder="${cfg.hasKey ? 'API key saved — leave blank to keep' : 'API key'}">
        <input name="baseUrl" placeholder="Base URL" value="${esc(cfg.baseUrl || '')}">
        </div><p class="muted small" id="aihint"></p>
        <div class="row"><button class="btn primary">Save</button><button class="btn" type="button" id="aitest">Test connection</button>
          <button class="btn" type="button" id="enrich" ${cfg.configured ? '' : 'disabled'}>Identify &amp; describe ${st.enrich.pending} new title${st.enrich.pending === 1 ? '' : 's'}</button></div>
        <div class="msg" id="aimsg"></div></form></div>

    <div class="panel"><h2>People</h2>
      <div class="list">${st.users.map((u) => `<div><span><strong>${esc(u.username)}</strong> ${u.isAdmin ? '<span class="chip">Admin</span>' : ''}</span>
        ${u.id === me.id ? '<span class="muted small">You</span>' : `<button class="btn danger" data-del-user="${u.id}" data-name="${esc(u.username)}">Remove</button>`}</div>`).join('')}</div>
      <form class="row" id="adduser"><input name="username" placeholder="Username" required autocomplete="off">
        <input name="password" type="password" placeholder="Password (8+ characters)" required autocomplete="new-password"><button class="btn primary">Add person</button></form>
      <div class="msg err" id="usererr"></div></div>`);

  const $ = (s) => app.querySelector(s);
  const fail = (sel) => (e) => { $(sel).className = 'msg err'; $(sel).textContent = e.message; };
  const aiForm = $('#ai');
  const syncAI = () => {
    const info = PROVIDER_INFO[aiForm.provider.value];
    aiForm.apiKey.hidden = !info?.key;
    aiForm.baseUrl.hidden = !info?.url;
    aiForm.model.hidden = !info;
    aiForm.model.placeholder = info ? `Model (${info.model})` : '';
    $('#aihint').textContent = info?.hint || 'AI features are off. Everything else works without them.';
  };
  aiForm.provider.onchange = syncAI;
  syncAI();
  const saveAI = async () => {
    const f = aiForm;
    ai = await api('/settings/ai', { method: 'PUT', body: { provider: f.provider.value, model: f.model.value, apiKey: f.apiKey.value, baseUrl: f.baseUrl.hidden ? '' : f.baseUrl.value } });
    $('#enrich').disabled = !ai.configured;
  };
  aiForm.onsubmit = async (e) => {
    e.preventDefault();
    await saveAI().then(() => { $('#aimsg').className = 'msg ok'; $('#aimsg').textContent = 'Saved.'; }, fail('#aimsg'));
  };
  $('#aitest').onclick = async () => {
    $('#aimsg').className = 'msg muted';
    $('#aimsg').textContent = 'Saving and testing…';
    try {
      await saveAI();
      await api('/ai/test', { method: 'POST' });
      $('#aimsg').className = 'msg ok';
      $('#aimsg').textContent = 'Connected — the model answered.';
    } catch (e) { fail('#aimsg')(e); }
  };
  $('#enrich').onclick = () => api('/ai/enrich', { method: 'POST' }).then(kick, fail('#aimsg'));
  $('#addlib').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    api('/libraries', { method: 'POST', body: { name: f.name.value, type: f.type.value, path: f.path.value } }).then(settingsView, fail('#liberr'));
  };
  $('#scan').onclick = () => api('/scan', { method: 'POST' }).then(kick, fail('#liberr'));
  $('#adduser').onsubmit = (e) => {
    e.preventDefault();
    api('/users', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } }).then(settingsView, fail('#usererr'));
  };
  app.querySelectorAll('[data-del-lib]').forEach((b) => (b.onclick = () => {
    if (confirm(`Remove the library “${b.dataset.name}”? Your files are not touched, but watch progress for it is deleted.`)) {
      api('/libraries/' + b.dataset.delLib, { method: 'DELETE' }).then(settingsView, fail('#liberr'));
    }
  }));
  app.querySelectorAll('[data-del-user]').forEach((b) => (b.onclick = () => {
    if (confirm(`Remove ${b.dataset.name}?`)) api('/users/' + b.dataset.delUser, { method: 'DELETE' }).then(settingsView, fail('#usererr'));
  }));

  // Live status for scans and AI enrichment.
  let timer;
  let wasBusy = false;
  const kick = () => { wasBusy = true; poll(); }; // a fast job may finish before the first poll
  async function poll() {
    clearTimeout(timer);
    if (!location.hash.startsWith('#/settings')) return;
    const s = await api('/admin/state').catch(() => null);
    if (!s || !$('#scanmsg')) return;
    const busy = s.scan.running || s.enrich.running;
    $('#scanmsg').textContent = s.scan.running
      ? `Scanning ${s.scan.library || ''}… ${s.scan.done}/${s.scan.total}`
      : s.scan.lastError ? `Last scan problem: ${s.scan.lastError}` : s.scan.finishedAt ? 'Scan complete.' : '';
    if (s.enrich.running) { $('#aimsg').className = 'msg muted'; $('#aimsg').textContent = `Identifying titles… ${s.enrich.done}/${s.enrich.total}`; }
    else if (s.enrich.lastError) { $('#aimsg').className = 'msg err'; $('#aimsg').textContent = s.enrich.lastError; }
    if (wasBusy && !busy && !s.enrich.lastError) return settingsView();
    wasBusy = busy;
    if (busy) timer = setTimeout(poll, 1000);
  }
  teardown = () => clearTimeout(timer);
  if (st.scan.running || st.enrich.running) poll();
  else if (st.scan.lastError) $('#scanmsg').textContent = `Last scan problem: ${st.scan.lastError}`;
}

// ── auth + routing ────────────────────────────────────────────────────────────
function authView(setup) {
  app.innerHTML = `<div class="auth"><img src="/logo.svg" alt=""><h1>${setup ? 'Welcome to Wingly' : 'Sign in'}</h1>
    <p class="muted">${setup ? 'Create the admin account for this server. It lives only on this machine.' : 'Your media, your server.'}</p>
    <form><input name="username" placeholder="Username" autocomplete="username" required autofocus>
      <input name="password" type="password" placeholder="Password${setup ? ' (8+ characters)' : ''}" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
      <button class="btn primary">${setup ? 'Create account' : 'Sign in'}</button><div class="msg err"></div></form></div>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(setup ? '/setup' : '/login', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } });
      boot();
    } catch (err) {
      app.querySelector('.msg').textContent = err.message;
    }
  };
}

async function render() {
  teardown?.();
  teardown = null;
  if (!me) return;
  const [, name = 'home', arg] = location.hash.split('/');
  const view = views[name || 'home'] || views.home;
  try {
    await view(arg);
  } catch (e) {
    if (me) shell('', `<div class="empty"><h1>Something went wrong</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Back home</a></div>`);
  }
  window.scrollTo(0, 0);
}

async function boot() {
  const s = await api('/status');
  me = s.user;
  ai = s.ai;
  if (!me) return authView(s.needsSetup);
  render();
}

window.addEventListener('hashchange', render);
boot();
