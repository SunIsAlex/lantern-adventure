(() => {
  // ============================================================
  // DOM
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const setupEl     = $('setup');
  const gameEl      = $('game');
  const scrollEl    = $('scroll');
  const loadingEl   = $('loading');
  const choicesWrap = $('choicesWrap');
  const choicesEl   = $('choices');
  const freeInput   = $('freeInput');
  const freeBtn     = $('freeBtn');
  const startBtn    = $('startBtn');
  const restartBtn  = $('restartBtn');
  const shareBtn    = $('shareBtn');
  const setupStatus = $('setupStatus');
  const setupError  = $('setupError');
  const gameError   = $('gameError');
  const endingStamp = $('endingStamp');
  const seedInput   = $('seed');
  const resumeCard  = $('resumeCard');
  const resumeMeta  = $('resumeMeta');
  const resumeExcerpt = $('resumeExcerpt');
  const resumeBtn   = $('resumeBtn');
  const discardBtn  = $('discardBtn');
  const toastEl     = $('toast');

  // ============================================================
  // Persistence layer — localStorage (private) + URL fragment (shareable)
  //
  // Two layers, two purposes:
  //   - localStorage : silent auto-save so refreshes / closing the tab don't
  //                    lose progress. Only visible to this browser.
  //   - URL fragment : the share button. Fragment, not query, so story
  //                    content never hits the server or any CDN access log,
  //                    and isn't truncated by EdgeOne's query-length limits.
  //
  // We use LZ-String's compressToEncodedURIComponent — already URL-safe, and
  // it compresses repetitive Chinese dialogue history to ~30-40% of original,
  // which buys us ~3x more shareable turns vs. plain base64.
  // ============================================================
  const SAVE_KEY     = 'lantern.save.v1';
  const SAVE_VERSION = 1;
  // Conservative shareable-URL size budget for the encoded fragment payload.
  // ~6000 chars leaves plenty of room below the practical 8000-char URL ceiling
  // once the origin + path + "#s=" prefix is included.
  const SHARE_MAX_LEN = 6000;

  // ============================================================
  // Game state
  // ============================================================
  let storyState   = null;
  let lastChoices  = [];
  let storyEnded   = false;
  let busy         = false;
  let selectedGenre = '';

  function buildSave() {
    if (!storyState) return null;
    return {
      v: SAVE_VERSION,
      savedAt: Date.now(),
      state: storyState,
      lastChoices: lastChoices,
      ended: storyEnded,
    };
  }

  function saveLocal() {
    if (!storyState) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(buildSave()));
    } catch (e) {
      // Storage may be disabled (private mode) or full. Non-fatal.
      console.warn('[save] localStorage write failed:', e);
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw);
      if (!save || save.v !== SAVE_VERSION || !save.state) return null;
      return save;
    } catch (e) {
      return null;
    }
  }

  function clearLocal() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  // ----- URL fragment encoding -----
  //
  // We use the browser's built-in CompressionStream (Baseline Widely Available
  // since May 2023, supported by all engines: Chrome/Edge/Firefox/Safari).
  // No external library needed — earlier we tried LZ-String from a CDN but the
  // SRI hash + China-mainland CDN reachability made it brittle.
  //
  // Pipeline: JSON → UTF-8 bytes → deflate-raw → base64url
  // - deflate-raw skips the zlib header/checksum (2 + 4 bytes saved vs deflate,
  //   and 18 bytes saved vs gzip), which matters because every byte costs ~1.33
  //   characters in URL-safe base64.
  // - base64url ('-', '_', no '=' padding) is fully URL-safe inside a fragment.

  function bytesToBase64Url(bytes) {
    // btoa needs a binary string; build it in 8K chunks to avoid call-stack
    // limits on long inputs.
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') +
                   '==='.slice((str.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function encodeShare(save) {
    try {
      const json = JSON.stringify(save);
      const utf8 = new TextEncoder().encode(json);
      const compressed = await deflate(utf8);
      return bytesToBase64Url(compressed);
    } catch (e) {
      console.warn('[share] encode failed:', e);
      return null;
    }
  }

  async function decodeShare(encoded) {
    try {
      const compressed = base64UrlToBytes(encoded);
      const utf8 = await inflate(compressed);
      const json = new TextDecoder().decode(utf8);
      const save = JSON.parse(json);
      if (!save || save.v !== SAVE_VERSION || !save.state) return null;
      return save;
    } catch (e) {
      console.warn('[share] decode failed:', e);
      return null;
    }
  }

  async function tryParseUrlFragment() {
    const hash = window.location.hash || '';
    const m = hash.match(/[#&]s=([^&]+)/);
    if (!m) return null;
    return await decodeShare(m[1]);
  }

  function clearUrlFragment() {
    // Strip the long fragment from the address bar after we've loaded it.
    if (window.location.hash) {
      const url = window.location.pathname + window.location.search;
      history.replaceState(null, '', url);
    }
  }

  // ============================================================
  // Genre chips
  // ============================================================
  document.querySelectorAll('#chips .chip').forEach((c) => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#chips .chip').forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      selectedGenre = c.dataset.g || '';
    });
  });

  // ============================================================
  // UI helpers
  // ============================================================
  function showSetupError(msg) {
    setupError.textContent = msg;
    setupError.classList.remove('hidden');
  }
  function clearSetupError() {
    setupError.classList.add('hidden');
    setupError.textContent = '';
  }
  function showGameError(msg) {
    gameError.textContent = msg;
    gameError.classList.remove('hidden');
  }
  function clearGameError() {
    gameError.classList.add('hidden');
    gameError.textContent = '';
  }

  let toastTimer = null;
  function toast(msg, duration = 2500) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
  }

  function setBusy(b) {
    busy = b;
    if (b) {
      loadingEl.classList.remove('hidden');
      choicesWrap.classList.add('hidden');
    } else {
      loadingEl.classList.add('hidden');
    }
    document.querySelectorAll('#choices .choice').forEach(c => c.disabled = b);
    freeBtn.disabled = b;
    freeInput.disabled = b;
    shareBtn.disabled = b;
  }

  function appendBeat({ kind, text, opening = false }) {
    const beat = document.createElement('article');
    beat.className = 'beat';

    const meta = document.createElement('div');
    meta.className = 'beat-meta ' + (kind === 'user' ? 'user' : 'narrator');
    const label = kind === 'user' ? '你的行动' : (opening ? '楔子' : '续章');
    meta.innerHTML = `<span class="dot"></span><span>${label}</span><hr/>`;
    beat.appendChild(meta);

    if (kind === 'user') {
      const p = document.createElement('p');
      p.className = 'player-action';
      p.textContent = text;
      beat.appendChild(p);
    } else {
      const body = document.createElement('div');
      body.className = 'narrative';
      const paras = text.split(/\n{2,}/);
      paras.forEach((para) => {
        const p = document.createElement('p');
        p.textContent = para.trim();
        body.appendChild(p);
      });
      beat.appendChild(body);
    }

    scrollEl.appendChild(beat);
    return beat;
  }

  function renderChoices(choices) {
    choicesEl.innerHTML = '';
    if (!choices || !choices.length) {
      choicesWrap.classList.add('hidden');
      return;
    }
    choices.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'choice';
      b.type = 'button';
      b.dataset.key = String.fromCharCode(65 + i);
      b.textContent = text;
      b.addEventListener('click', () => submitAction(text));
      choicesEl.appendChild(b);
    });
    freeInput.value = '';
    choicesWrap.classList.remove('hidden');
  }

  function showEnding() {
    storyEnded = true;
    endingStamp.classList.remove('hidden');
    choicesWrap.classList.add('hidden');
  }

  // ============================================================
  // ============================================================
  // SSE streaming helpers
  // ============================================================

  // Create an empty narrator beat with a live text node we can append chars to.
  function createStreamingBeat(opening = false) {
    const beat = document.createElement('article');
    beat.className = 'beat';
    const meta = document.createElement('div');
    meta.className = 'beat-meta narrator';
    meta.innerHTML = `<span class="dot"></span><span>${opening ? '楔子' : '续章'}</span><hr/>`;
    beat.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'narrative';
    // We'll accumulate raw text here and re-render paragraphs as it grows.
    body._raw = '';
    beat.appendChild(body);
    scrollEl.appendChild(beat);
    return { beat, body };
  }

  // Render the full narrative text into a beat created by createStreamingBeat.
  // Re-splits on double-newline into paragraphs, same as the old per-char
  // renderer did, just done once instead of after every character.
  function setBeatText({ body, beat }, text) {
    body._raw = String(text || '');
    const paras = body._raw.split(/\n\n/);
    body.innerHTML = '';
    paras.forEach((para, idx) => {
      if (!para && idx < paras.length - 1) return;
      const p = document.createElement('p');
      p.textContent = para;
      body.appendChild(p);
    });
    beat.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // Post JSON to an Edge Function and return the parsed response body.
  // Throws Error on non-OK responses or { ok:false } payloads.
  async function postJSON(url, payload) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data;
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok || !data || data.ok === false) {
      throw new Error(data?.error || `请求失败，HTTP ${resp.status}`);
    }
    return data;
  }

  // ============================================================
  // API — streaming
  // ============================================================

  async function startStory() {
    clearSetupError();
    startBtn.disabled = true;
    setupStatus.innerHTML = '提灯正在点亮<span class="dots"><span>.</span><span>.</span><span>.</span></span>';

    try {
      const seed = seedInput.value.trim();
      enterGameView();
      scrollEl.innerHTML = '';
      storyEnded = false;

      // Create a beat immediately — text will stream into it.
      const streamCtx = createStreamingBeat(true);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      const done = await postJSON('/api/start', { genre: selectedGenre, seed });
      setBeatText(streamCtx, done.narrative);

      storyState  = done.state;
      lastChoices = done.choices || [];

      renderChoices(lastChoices);
      saveLocal();
    } catch (err) {
      // If we already entered game view but errored, go back to setup.
      if (!gameEl.classList.contains('hidden')) {
        gameEl.classList.add('hidden');
        setupEl.classList.remove('hidden');
      }
      showSetupError(err.message || String(err));
    } finally {
      startBtn.disabled = false;
      setupStatus.textContent = '';
    }
  }

  async function submitAction(action) {
    if (busy || !storyState) return;
    const text = String(action || '').trim();
    if (!text) return;

    clearGameError();
    const userBeat = appendBeat({ kind: 'user', text });
    requestAnimationFrame(() =>
      userBeat.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
    setBusy(true);

    try {
      const streamCtx = createStreamingBeat(false);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      const done = await postJSON('/api/continue', { state: storyState, action: text });
      setBeatText(streamCtx, done.narrative);

      storyState  = done.state;
      lastChoices = done.choices || [];

      if (done.ended) {
        showEnding();
      } else {
        renderChoices(lastChoices);
      }

      saveLocal();
    } catch (err) {
      showGameError(err.message || String(err));
      if (lastChoices.length) renderChoices(lastChoices);
      else choicesWrap.classList.remove('hidden');
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // Resume / restart
  // ============================================================
  function enterGameView() {
    setupEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    endingStamp.classList.add('hidden');
    storyEnded = false;
  }

  function rebuildStoryFromState(state) {
    scrollEl.innerHTML = '';
    const history = Array.isArray(state.history) ? state.history : [];
    history.forEach((beat, idx) => {
      if (beat.role === 'assistant') {
        appendBeat({ kind: 'narrator', text: beat.text, opening: idx === 0 });
      } else if (beat.role === 'user') {
        appendBeat({ kind: 'user', text: beat.text });
      }
      // 'system' notes (history-elision markers) are skipped in the UI.
    });
  }

  function loadSave(save, { fromShare = false } = {}) {
    storyState  = save.state;
    lastChoices = save.lastChoices || [];
    storyEnded  = !!save.ended;

    enterGameView();
    rebuildStoryFromState(storyState);

    if (storyEnded) {
      showEnding();
    } else {
      renderChoices(lastChoices);
    }

    // Always re-save locally — a shared link becomes the recipient's own save.
    saveLocal();

    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });

    if (fromShare) {
      toast('已载入分享的故事进度');
      clearUrlFragment();
    }
  }

  function showResumeCard(save) {
    const history = save.state?.history || [];
    const turns = history.filter(b => b.role === 'user').length;
    const title = save.state?.title || '无名故事';
    const genre = save.state?.genre || '';
    const lastAssistant = [...history].reverse().find(b => b.role === 'assistant');
    const excerpt = lastAssistant ? lastAssistant.text.replace(/\n+/g, ' ') : '';

    const when = new Date(save.savedAt || Date.now());
    const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`;

    resumeMeta.textContent = `${title}${genre ? ' · ' + genre : ''} · 已进行 ${turns} 个回合 · ${whenStr}`;
    resumeExcerpt.textContent = excerpt;
    resumeCard.classList.remove('hidden');
  }

  resumeBtn.addEventListener('click', () => {
    const save = loadLocal();
    if (!save) {
      resumeCard.classList.add('hidden');
      return;
    }
    loadSave(save);
  });

  discardBtn.addEventListener('click', () => {
    if (!confirm('确认丢弃当前存档？这一段故事将无法再找回。')) return;
    clearLocal();
    resumeCard.classList.add('hidden');
  });

  function restart() {
    // Don't auto-wipe the save here. The new story will overwrite it as
    // it progresses; if the player abandons mid-setup, the old save remains.
    storyState   = null;
    lastChoices  = [];
    storyEnded   = false;
    scrollEl.innerHTML = '';
    choicesEl.innerHTML = '';
    endingStamp.classList.add('hidden');
    choicesWrap.classList.add('hidden');
    gameEl.classList.add('hidden');
    setupEl.classList.remove('hidden');
    clearGameError();
    clearSetupError();
    const save = loadLocal();
    if (save) showResumeCard(save);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ============================================================
  // Share
  // ============================================================
  async function shareProgress() {
    if (!storyState) return;
    const encoded = await encodeShare(buildSave());

    if (!encoded) {
      toast('生成分享链接失败，请重试');
      return;
    }

    if (encoded.length > SHARE_MAX_LEN) {
      toast('故事太长，无法直接分享。建议玩到结局或截图分享。', 4000);
      return;
    }

    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`;

    // Prefer native share sheet on mobile; fall back to clipboard.
    if (navigator.share) {
      try {
        await navigator.share({
          title: `提灯人 · ${storyState.title || '一段未完的故事'}`,
          text: '在这盏灯下，我留了一段故事给你——',
          url,
        });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
        // Otherwise fall through to clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      toast(`链接已复制（${encoded.length.toLocaleString()} 字符）`);
    } catch (e) {
      prompt('复制下面的链接分享给朋友：', url);
    }
  }

  // ============================================================
  // Wire up
  // ============================================================
  startBtn.addEventListener('click', startStory);
  restartBtn.addEventListener('click', restart);
  shareBtn.addEventListener('click', shareProgress);
  freeBtn.addEventListener('click', () => {
    const v = freeInput.value.trim();
    if (v) submitAction(v);
  });
  freeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      freeBtn.click();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (busy || gameEl.classList.contains('hidden')) return;
    if (document.activeElement === freeInput) return;
    const k = e.key.toUpperCase();
    if (['A','B','C','D'].includes(k)) {
      const idx = k.charCodeAt(0) - 65;
      const buttons = choicesEl.querySelectorAll('.choice');
      if (buttons[idx]) {
        e.preventDefault();
        buttons[idx].click();
      }
    }
  });

  // ============================================================
  // Boot
  //   1. URL fragment (shared link) wins — overrides local save
  //   2. localStorage  → show resume card; user decides
  //   3. Otherwise: fresh start
  // ============================================================
  (async function boot() {
    const shared = await tryParseUrlFragment();
    if (shared) {
      loadSave(shared, { fromShare: true });
      return;
    }
    const local = loadLocal();
    if (local) {
      showResumeCard(local);
    }
  })();

})();
