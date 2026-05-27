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
  // ============================================================
  const SAVE_KEY     = 'lantern.save.v1';
  const SAVE_VERSION = 1;
  const SHARE_MAX_LEN = 6000;

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
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(buildSave())); }
    catch (e) { console.warn('[save] localStorage write failed:', e); }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw);
      if (!save || save.v !== SAVE_VERSION || !save.state) return null;
      return save;
    } catch (e) { return null; }
  }

  function clearLocal() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  // ----- URL fragment encode/decode (CompressionStream + base64url) -----
  function bytesToBase64Url(bytes) {
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
      const utf8 = new TextEncoder().encode(JSON.stringify(save));
      const compressed = await deflate(utf8);
      return bytesToBase64Url(compressed);
    } catch (e) { console.warn('[share] encode failed:', e); return null; }
  }
  async function decodeShare(encoded) {
    try {
      const compressed = base64UrlToBytes(encoded);
      const utf8 = await inflate(compressed);
      const save = JSON.parse(new TextDecoder().decode(utf8));
      if (!save || save.v !== SAVE_VERSION || !save.state) return null;
      return save;
    } catch (e) { console.warn('[share] decode failed:', e); return null; }
  }
  async function tryParseUrlFragment() {
    const m = (window.location.hash || '').match(/[#&]s=([^&]+)/);
    return m ? await decodeShare(m[1]) : null;
  }
  function clearUrlFragment() {
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
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
  function showSetupError(msg) { setupError.textContent = msg; setupError.classList.remove('hidden'); }
  function clearSetupError() { setupError.classList.add('hidden'); setupError.textContent = ''; }
  function showGameError(msg) { gameError.textContent = msg; gameError.classList.remove('hidden'); }
  function clearGameError() { gameError.classList.add('hidden'); gameError.textContent = ''; }

  let toastTimer = null;
  function toast(msg, duration = 2500) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
  }

  function setBusy(b, { showLoading = true } = {}) {
    busy = b;
    if (b) {
      if (showLoading) loadingEl.classList.remove('hidden');
      choicesWrap.classList.add('hidden');
    } else {
      loadingEl.classList.add('hidden');
    }
    document.querySelectorAll('#choices .choice').forEach(c => c.disabled = b);
    freeBtn.disabled = b;
    freeInput.disabled = b;
    shareBtn.disabled = b;
  }

  // ============================================================
  // Inline markup parser
  //
  // Whitelisted paired tags + one self-closing tag. Never touches innerHTML.
  // Anything that doesn't match the strict shape is left as literal text via
  // textContent — so a partially-typed `[[em` shows up as plain characters
  // and "collapses" into <span class="tag-em"> once `]]` arrives and the
  // matching `[[/em]]` is later seen.
  // ============================================================
  const INLINE_TAGS = new Set(['EM', 'DIALOG', 'NAME', 'SENSE', 'WHISPER']);
  const SELF_CLOSING_TAGS = new Set(['BREAK']);

  function appendInline(parent, text) {
    const re = /\[\[\/?[A-Za-z]+\]\]|<<\/?[A-Za-z]+>>|\{\{\/?[A-Za-z]+\}\}/g;
    let lastIndex = 0;
    const stack = [parent];
    const top = () => stack[stack.length - 1];

    const matches = [...text.matchAll(re)];
    for (const m of matches) {
      const literal = text.slice(lastIndex, m.index);
      if (literal) top().appendChild(document.createTextNode(literal));
      lastIndex = m.index + m[0].length;

      const tok = m[0];
      const isClose = tok.startsWith('[[/') || tok.startsWith('<</') || tok.startsWith('{{/');
      const name = tok.replace(/[\[\]<>\/\{\}]/g, '').toUpperCase();

      if (!isClose && SELF_CLOSING_TAGS.has(name)) {
        const el = document.createElement('span');
        el.className = 'tag-' + name;
        top().appendChild(el);
        continue;
      }
      if (!isClose && INLINE_TAGS.has(name)) {
        const el = document.createElement('span');
        el.className = 'tag-' + name;
        top().appendChild(el);
        stack.push(el);
        continue;
      }
      if (isClose && INLINE_TAGS.has(name)) {
        const topEl = top();
        if (topEl !== parent && topEl.className === 'tag-' + name) {
          stack.pop();
          continue;
        }
      }
      top().appendChild(document.createTextNode(tok));
    }
    const tail = text.slice(lastIndex);
    if (tail) top().appendChild(document.createTextNode(tail));
  }

  // ============================================================
  // Append a chunk of text to the live narrative body.
  //
  // Re-renders the current paragraph from its raw slice on every chunk.
  //
  // Markup-aware pacing: if the raw text currently ends *inside* a markup
  // token (e.g. "...村口[[", or "...[[em]]心跳[[/e"), we skip the DOM update
  // for this tick. The characters are kept in _raw and will be rendered when
  // the next tick(s) bring the closing brackets. Visual effect: the player
  // never sees a half-typed "[[em]]"; instead the styled phrase appears in
  // one flash the moment the token closes.
  //
  // body._raw            : entire raw text seen so far
  // body._paraRawStarts  : index in _raw where each paragraph begins
  // body._liveP          : the currently-growing <p> element
  // ============================================================
  function appendChunkToBody(body, chunk) {
    if (!body._raw) {
      body._raw = '';
      body._paraRawStarts = [0];
      body._liveP = null;
    }

    const prevLen = body._raw.length;
    body._raw += chunk;

    // Track paragraph breaks. We do this even when we're inside a token —
    // the model never writes "\n\n" inside a markup tag in practice, but if
    // it ever did, we still want correct paragraph indexing.
    for (let i = prevLen; i < body._raw.length; i++) {
      if (body._raw[i] === '\n' && i > 0 && body._raw[i - 1] === '\n') {
        body._paraRawStarts.push(i + 1);
        body._liveP = null;
      }
    }

    // If raw ends inside an unclosed markup token, defer the render until
    // the closing bracket arrives. Detecting "inside a token" is cheap:
    // look at the tail since the last `[[` or `<<` — if it doesn't contain
    // the matching `]]` or `>>`, we're still inside.
    if (endsInsideMarkup(body._raw)) return;

    const lastParaStart = body._paraRawStarts[body._paraRawStarts.length - 1];
    const lastParaText = body._raw.slice(lastParaStart).replace(/\n+$/, '');
    if (!lastParaText) return;

    if (!body._liveP) {
      body._liveP = document.createElement('p');
      body.appendChild(body._liveP);
    }
    body._liveP.replaceChildren();
    appendInline(body._liveP, lastParaText);
  }

  // Returns true if `text` ends in the middle of an unclosed [[...]] or
  // <<...>> token. Used by appendChunkToBody to pause rendering until the
  // token completes.
  function endsInsideMarkup(text) {
  const tail = text.slice(-30);

  const lastSqOpen = tail.lastIndexOf('[[');
  const lastAgOpen = tail.lastIndexOf('<<');
  const lastCuOpen = tail.lastIndexOf('{{');

  if (lastSqOpen !== -1 && tail.indexOf(']]', lastSqOpen + 2) === -1) return true;
  if (lastAgOpen !== -1 && tail.indexOf('>>', lastAgOpen + 2) === -1) return true;
  if (lastCuOpen !== -1 && tail.indexOf('}}', lastCuOpen + 2) === -1) return true;
  return false;
}

  function renderToBody(body, text) {
    const paras = String(text || '').split(/\n\n/);
    body.replaceChildren();
    paras.forEach((para, idx) => {
      if (!para && idx < paras.length - 1) return;
      const p = document.createElement('p');
      appendInline(p, para);
      body.appendChild(p);
    });
  }

  // ============================================================
  // Beats (story DOM nodes)
  // ============================================================
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
      renderToBody(body, text);
      beat.appendChild(body);
    }
    scrollEl.appendChild(beat);
    return beat;
  }

  function createStreamingBeat(opening = false) {
    const beat = document.createElement('article');
    beat.className = 'beat';
    const meta = document.createElement('div');
    meta.className = 'beat-meta narrator';
    meta.innerHTML = `<span class="dot"></span><span>${opening ? '楔子' : '续章'}</span><hr/>`;
    beat.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'narrative';
    beat.appendChild(body);
    scrollEl.appendChild(beat);
    return { beat, body };
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
    choicesEl.scrollIntoView({behavior:"smooth",block:"end"});
  }

  function showEnding() {
    storyEnded = true;
    endingStamp.classList.remove('hidden');
    choicesWrap.classList.add('hidden');
  }

  // ============================================================
  // /api/narrate — non-streaming.
  //
  // We tried real SSE streaming and gave up: server-side it streams fine
  // (verified by curl), but every browser path we tried (fetch + ReadableStream,
  // EventSource, localhost, production) ended up buffering the entire response
  // before delivery. Root cause is somewhere between the browser's networking
  // stack and the network path — undiagnosed.  For now we just fetch the full
  // narration as JSON and animate a client-side typewriter for pacing.
  // ============================================================
  async function fetchNarration(payload) {
    const resp = await fetch('/api/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data;
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok || !data || data.ok === false) {
      throw new Error(data?.error || `请求失败，HTTP ${resp.status}`);
    }
    return String(data.narrative || '').trim();
  }

  // Animate full text into a streaming beat one slice at a time. Same DOM
  // path as the old streaming version (appendChunkToBody), so inline markup
  // tokens still "collapse" into styled spans as their closing brackets land.
  function typewriterInto(streamCtx, fullText, { speedMs = 35, step = 2 } = {}) {
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        if (i >= fullText.length) { resolve(); return; }
        const next = Math.min(i + step, fullText.length);
        appendChunkToBody(streamCtx.body, fullText.slice(i, next));
        streamCtx.beat.scrollIntoView({ block: 'end' });
        i = next;
        setTimeout(tick, speedMs);
      };
      tick();
    });
  }

  // ============================================================
  // POST helper for /api/choices
  // ============================================================
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
  // Title sanitizer — strip inline markup before using as document.title.
  // ============================================================
  function cleanTitle(t) {
    return String(t || '').replace(/\[\[\/?[A-Za-z]+\]\]|<<\/?[A-Za-z]+>>|\{\{\/?[A-Za-z]+\}\}/g, '').trim() || '提灯人';
  }

  // ============================================================
  // Story flow
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

      const streamCtx = createStreamingBeat(true);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      // Stage 1: fetch narrative (block) + typewriter
      const narration = await fetchNarration({ genre: selectedGenre, seed });
      await typewriterInto(streamCtx, narration);

      // Stage 2: fetch choices + meta
      loadingEl.classList.remove('hidden');
      const choicesResp = await postJSON('/api/choices', {
        narration,
        genre: selectedGenre,
        seed,
      });
      loadingEl.classList.add('hidden');

      const meta = choicesResp.meta || {};
      storyState = {
        title:       cleanTitle(meta.title),
        genre:       meta.genre       || selectedGenre || '',
        protagonist: meta.protagonist || '',
        setting:     meta.setting     || '',
        summary:     meta.summary     || '',
        history: [{ role: 'assistant', text: narration }],
      };
      document.title = storyState.title;
      lastChoices = choicesResp.choices || [];

      if (choicesResp.ended) showEnding();
      else renderChoices(lastChoices);

      saveLocal();
    } catch (err) {
      if (!gameEl.classList.contains('hidden')) {
        gameEl.classList.add('hidden');
        setupEl.classList.remove('hidden');
      }
      showSetupError(err.message || String(err));
    } finally {
      startBtn.disabled = false;
      setupStatus.textContent = '';
      loadingEl.classList.add('hidden');
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
    setBusy(true, { showLoading: false });

    try {
      const streamCtx = createStreamingBeat(false);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      // Stage 1: fetch narrative (block) + typewriter
      loadingEl.classList.remove('hidden');
      const narration = await fetchNarration({ state: storyState, action: text });
      loadingEl.classList.add('hidden');
      await typewriterInto(streamCtx, narration);

      // Stage 2: fetch choices
      loadingEl.classList.remove('hidden');
      const choicesResp = await postJSON('/api/choices', {
        narration,
        action: text,
        state: storyState,
      });
      loadingEl.classList.add('hidden');

      storyState = {
        ...storyState,
        summary: choicesResp.summary_update || storyState.summary,
        history: [
          ...storyState.history,
          { role: 'user',      text },
          { role: 'assistant', text: narration },
        ],
      };
      lastChoices = choicesResp.choices || [];

      if (choicesResp.ended) showEnding();
      else renderChoices(lastChoices);

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
    });
  }

  function loadSave(save, { fromShare = false } = {}) {
    storyState  = save.state;
    lastChoices = save.lastChoices || [];
    storyEnded  = !!save.ended;
    document.title = cleanTitle(storyState?.title);

    enterGameView();
    rebuildStoryFromState(storyState);

    if (storyEnded) showEnding();
    else renderChoices(lastChoices);

    saveLocal();
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
    if (fromShare) { toast('已载入分享的故事进度'); clearUrlFragment(); }
  }

  function showResumeCard(save) {
    const history = save.state?.history || [];
    const turns = history.filter(b => b.role === 'user').length;
    const title = save.state?.title || '无名故事';
    const genre = save.state?.genre || '';
    const lastAssistant = [...history].reverse().find(b => b.role === 'assistant');
    const excerpt = lastAssistant
      ? lastAssistant.text.replace(/\[\[\/?[A-Za-z]+\]\]|<<\/?[A-Za-z]+>>|\{\{\/?[A-Za-z]+\}\}/g, '').replace(/\n+/g, ' ')
      : '';

    const when = new Date(save.savedAt || Date.now());
    const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`;

    resumeMeta.textContent = `${title}${genre ? ' · ' + genre : ''} · 已进行 ${turns} 个回合 · ${whenStr}`;
    resumeExcerpt.textContent = excerpt;
    resumeCard.classList.remove('hidden');
  }

  resumeBtn.addEventListener('click', () => {
    const save = loadLocal();
    if (!save) { resumeCard.classList.add('hidden'); return; }
    loadSave(save);
  });

  discardBtn.addEventListener('click', () => {
    if (!confirm('确认丢弃当前存档？这一段故事将无法再找回。')) return;
    clearLocal();
    resumeCard.classList.add('hidden');
  });

  function restart() {
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
    if (!encoded) { toast('生成分享链接失败，请重试'); return; }
    if (encoded.length > SHARE_MAX_LEN) {
      toast('故事太长，无法直接分享。建议玩到结局或截图分享。', 4000);
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: `提灯人 · ${storyState.title || '一段未完的故事'}`,
          text: '在这盏灯下，我留了一段故事给你——',
          url,
        });
        return;
      } catch (e) { if (e?.name === 'AbortError') return; }
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
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); freeBtn.click(); }
  });
  document.addEventListener('keydown', (e) => {
    if (busy || gameEl.classList.contains('hidden')) return;
    if (document.activeElement === freeInput) return;
    const k = e.key.toUpperCase();
    if (['A','B','C','D'].includes(k)) {
      const idx = k.charCodeAt(0) - 65;
      const buttons = choicesEl.querySelectorAll('.choice');
      if (buttons[idx]) { e.preventDefault(); buttons[idx].click(); }
    }
  });

  // ============================================================
  // Boot
  // ============================================================
  (async function boot() {
    const shared = await tryParseUrlFragment();
    if (shared) { loadSave(shared, { fromShare: true }); return; }
    const local = loadLocal();
    if (local) showResumeCard(local);
  })();
})();