// EdgeOne Pages Edge Function
// Route: POST /api/continue
//
// Streaming response protocol (text/event-stream):
//   data: {"type":"char","char":"你"}      <- one character at a time
//   ...
//   data: {"type":"done","choices":[...],"ended":false,"state":{...}}
//   data: [DONE]

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

const SYSTEM_PROMPT = `你是互动小说作者，续写文字冒险游戏。规则：
1. 只返回合法 JSON，不加 Markdown 围栏或解释。
2. 叙述用第二人称"你"，120-200 汉字，2-3 段，段间用 \\n\\n。
3. 承接玩家动作给出具体后果，结尾留悬念，不替玩家做下一步决定。
4. 约每 8 回合可触发自然结局，此时 ended:true，choices:[]。
5. 若玩家动作超出世界观，让世界合理拒绝，不要训话。`;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const apiKey = context.env?.DEEPSEEK_API_KEY;
  if (!apiKey) return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);

  let body;
  try { body = await context.request.json(); }
  catch (_) { return jsonError('请求体必须是 JSON。', 400); }

  const action  = String(body?.action || '').trim().slice(0, 500);
  if (!action) return jsonError('缺少 action 字段。', 400);

  const inState = body?.state || {};
  const history = Array.isArray(inState.history) ? inState.history : [];
  const trimmed = history.length > 12
    ? [history[0], { role: 'system', text: '……（中间情节省略）……' }, ...history.slice(-10)]
    : history;

  // Build messages
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  const bible = [
    inState.title       ? `标题：${inState.title}`           : '',
    inState.genre       ? `题材：${inState.genre}`           : '',
    inState.protagonist ? `主角：${inState.protagonist}`     : '',
    inState.setting     ? `背景：${inState.setting}`         : '',
    inState.summary     ? `纲要（勿复述）：${inState.summary}` : '',
  ].filter(Boolean).join('\n');
  if (bible) messages.push({ role: 'system', content: bible });

  for (const beat of trimmed) {
    if      (beat.role === 'assistant') messages.push({ role: 'assistant', content: beat.text });
    else if (beat.role === 'user')      messages.push({ role: 'user',      content: `玩家行动：${beat.text}` });
    else                                messages.push({ role: 'system',    content: beat.text });
  }

  messages.push({
    role: 'user',
    content: `玩家行动：${action}

返回 JSON：
{"narrative":"续写正文120-200字2-3段","choices":["选项A≤20字","选项B","选项C","选项D"],"ended":false,"summary_update":""}

选项4个，差异化。结局时 ended:true，choices:[]。`,
  });

  // ── Call DeepSeek stream:true ────────────────────────────────────────────
  let dsResp;
  try {
    dsResp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.9,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        stream: true,
        thinking: { type: 'disabled' },
      }),
      eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
    });
  } catch (err) {
    return jsonError(`连接 DeepSeek 失败：${err.message}`, 502);
  }
  if (!dsResp.ok) {
    const t = await dsResp.text();
    return jsonError(`DeepSeek API ${dsResp.status}: ${t.slice(0, 200)}`, 502);
  }

  // ── Stream back to client ────────────────────────────────────────────────
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const sseResponse = new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    },
  });

  (async () => {
    const send = async (obj) => {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };

    try {
      let accumulated = '';
      const reader = dsResp.body.getReader();
      const lineDecoder = new TextDecoder();
      let leftover = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = leftover + lineDecoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        leftover = lines.pop();
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith('data:')) continue;
          const payload = trimmedLine.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            const delta = evt?.choices?.[0]?.delta?.content;
            if (delta) accumulated += delta;
          } catch (_) {}
        }
      }
      if (leftover.trim().startsWith('data:')) {
        const payload = leftover.trim().slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            const evt = JSON.parse(payload);
            const delta = evt?.choices?.[0]?.delta?.content;
            if (delta) accumulated += delta;
          } catch (_) {}
        }
      }

      const cleaned = accumulated.trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
        else throw new Error('DeepSeek 返回的不是合法 JSON。');
      }

      const narrative = String(parsed.narrative || '').trim();
      const ended = Boolean(parsed.ended);
      const choices = ended ? [] :
        (Array.isArray(parsed.choices) ? parsed.choices : [])
          .map(c => String(c).trim()).filter(Boolean).slice(0, 4);

      if (!narrative) { await send({ type: 'error', error: '模型返回剧情为空，请重试。' }); return; }
      if (!ended && choices.length < 2) { await send({ type: 'error', error: '模型未返回足够选项，请重试。' }); return; }

      const newSummary = (typeof parsed.summary_update === 'string' && parsed.summary_update.trim())
        ? parsed.summary_update.trim().slice(0, 200)
        : inState.summary || '';

      const outState = {
        title:       inState.title       || '',
        genre:       inState.genre       || '',
        protagonist: inState.protagonist || '',
        setting:     inState.setting     || '',
        summary:     newSummary,
        history: [...history, { role: 'user', text: action }, { role: 'assistant', text: narrative }],
      };

      // Stream narrative char by char.
      for (const ch of narrative) {
        await send({ type: 'char', char: ch });
      }

      await send({ type: 'done', choices, ended, state: outState });
      await writer.write(enc.encode('data: [DONE]\n\n'));

    } catch (err) {
      try {
        await writer.write(enc.encode(
          `data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`
        ));
      } catch (_) {}
    } finally {
      try { await writer.close(); } catch (_) {}
    }
  })();

  return sseResponse;
}

// ── helpers ────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}
