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
  // (unchanged from before; see history for design notes)
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
  // textContent — so half-streamed `[[em` will show up as plain characters,
  // and "collapse" into <span class="tag-em"> as soon as `]]` arrives and the
  // matching `[[/em]]` is later seen. This is intentional: the player gets to
  // watch the prose typeset itself.
  // ============================================================
  const INLINE_TAGS = new Set(['em', 'dialog', 'name', 'sense', 'whisper']);
  const SELF_CLOSING_TAGS = new Set(['break']);

  function appendInline(parent, text) {
    const re = /\[\[\/?[a-z]+\]\]|<<\/?[a-z]+>>/g;
    let lastIndex = 0;
    const stack = [parent];
    const top = () => stack[stack.length - 1];

    const matches = [...text.matchAll(re)];
    for (const m of matches) {
      const literal = text.slice(lastIndex, m.index);
      if (literal) top().appendChild(document.createTextNode(literal));
      lastIndex = m.index + m[0].length;

      const tok = m[0];
      const isClose = tok.startsWith('[[/') || tok.startsWith('<</');
      const name = tok.replace(/[\[\]<>\/]/g, '');

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
    body._raw = '';
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
  }

  function showEnding() {
    storyEnded = true;
    endingStamp.classList.remove('hidden');
    choicesWrap.classList.add('hidden');
  }

 // ============================================================
  // OpenAI-format SSE consumer for /api/narrate
  //
  // We use XMLHttpRequest + the 'progress' event instead of fetch +
  // ReadableStream. Why: mobile browsers (WeChat webview, QQ Browser, even
  // some Chrome/Safari builds) buffer ReadableStream chunks aggressively
  // before invoking reader.read(), making the stream look pseudo-stream:
  // bytes arrive in bursts of dozens at a time even when the server is
  // emitting one token every ~50ms. XHR's progress event fires at the
  // socket level — every batch of bytes the kernel hands the browser
  // triggers a callback immediately.
  //
  // We track xhr.responseText length and only process the *new* tail since
  // the last progress event.
  // ============================================================
  function streamNarrate(payload, onChunk) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/narrate', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      // Tell the browser we want raw text, not a parsed document.
      xhr.responseType = 'text';

      let processedLen = 0;   // bytes of responseText already parsed
      let leftover = '';      // partial line carried across events
      let fullText = '';      // accumulated narration
      let sawSSE = false;     // confirmed content-type is event-stream

      function processNew() {
        // responseText may be undefined briefly on some platforms.
        const all = xhr.responseText;
        if (!all || all.length <= processedLen) return;
        const fresh = all.slice(processedLen);
        processedLen = all.length;

        const text = leftover + fresh;
        const lines = text.split('\n');
        leftover = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return;

          let evt;
          try { evt = JSON.parse(data); } catch (_) { continue; }
          if (evt.error) {
            reject(new Error(evt.error.message || evt.error || '叙事流出错'));
            xhr.abort();
            return;
          }
          const delta = evt?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            console.log('[chunk]', performance.now().toFixed(0), JSON.stringify(delta));
            try { onChunk(delta); } catch (e) { /* don't kill the stream */ }
          }
        }
      }

      xhr.onreadystatechange = () => {
        // readyState 2 = HEADERS_RECEIVED. Check we got SSE back, not a JSON
        // error envelope.
        if (xhr.readyState === 2) {
          const ct = (xhr.getResponseHeader('Content-Type') || '').toLowerCase();
          sawSSE = ct.includes('text/event-stream');
        }
      };

      xhr.onprogress = () => {
        if (!sawSSE) return;  // wait until headers confirm SSE
        processNew();
      };

      xhr.onload = () => {
        if (!sawSSE) {
          // Server returned JSON error envelope; surface the message.
          let msg;
          try { msg = JSON.parse(xhr.responseText)?.error; } catch (_) {}
          reject(new Error(msg || `请求失败，HTTP ${xhr.status}`));
          return;
        }
        // Final flush — onprogress may have missed the last bytes.
        processNew();
        if (!fullText) {
          reject(new Error('叙事流意外结束，请重试。'));
        } else {
          resolve(fullText);
        }
      };

      xhr.onerror = () => reject(new Error('网络错误，请检查连接后重试。'));
      xhr.ontimeout = () => reject(new Error('请求超时，请重试。'));

      xhr.send(JSON.stringify(payload));
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
    return String(t || '').replace(/\[\[\/?[a-z]+\]\]|<<\/?[a-z]+>>/g, '').trim() || '提灯人';
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

      // ── Stage 1: stream narrative ─────────────────────────────────────
      const streamCtx = createStreamingBeat(true);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      const narration = await streamNarrate(
        { genre: selectedGenre, seed },
        (chunk) => {
          streamCtx.body._raw += chunk;
          renderToBody(streamCtx.body, streamCtx.body._raw);
          streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      );

      // ── Stage 2: fetch choices + meta ─────────────────────────────────
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
      // ── Stage 1: stream narrative ─────────────────────────────────────
      const streamCtx = createStreamingBeat(false);
      requestAnimationFrame(() =>
        streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );

      const narration = await streamNarrate(
        { state: storyState, action: text },
        (chunk) => {
          streamCtx.body._raw += chunk;
          renderToBody(streamCtx.body, streamCtx.body._raw);
          streamCtx.beat.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      );

      // ── Stage 2: fetch choices ────────────────────────────────────────
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
  // Resume / restart  (unchanged)
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
      ? lastAssistant.text.replace(/\[\[\/?[a-z]+\]\]|<<\/?[a-z]+>>/g, '').replace(/\n+/g, ' ')
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
  // Share  (unchanged)
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