// EdgeOne Pages Edge Function
// Route: POST /api/start
//
// Streaming response protocol (text/event-stream):
//   data: {"type":"char","char":"你"}      <- one character at a time
//   ...
//   data: {"type":"done","title":"...","choices":[...],"state":{...}}
//   data: [DONE]
//
// On error before streaming starts: normal JSON  {"ok":false,"error":"..."}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

const SYSTEM_PROMPT = `你是互动小说作者，为文字冒险游戏写中文故事。规则：
1. 只返回合法 JSON，不加 Markdown 围栏或解释。
2. 叙述用第二人称"你"，120-200 汉字，2-3 段，段间用 \\n\\n。
3. 用感官细节开场，结尾留悬念，不替玩家做决定。`;

const OPENING_USER_TEMPLATE = (genre, seed) =>
  `生成文字冒险开场。${genre ? `题材：${genre}。` : '自选有趣题材。'}${seed ? `灵感：${seed}。` : ''}

返回 JSON：
{"title":"6-12字标题","genre":"题材标签","protagonist":"主角名+一句话身份","setting":"世界背景一句话","summary":"剧情纲要≤20字（玩家不可见）","opening":"开场正文120-200字2-3段","choices":["选项A≤20字","选项B","选项C","选项D"]}

选项4个，分别代表谨慎/激进/狡猾/意外，用"我…"或祈使句开头。`;

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestPost(context) {
  const apiKey = context.env?.DEEPSEEK_API_KEY;
  if (!apiKey) return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);

  let body = {};
  try { body = await context.request.json(); } catch (_) {}
  const genre = typeof body.genre === 'string' ? body.genre.slice(0, 40) : '';
  const seed  = typeof body.seed  === 'string' ? body.seed.slice(0, 200) : '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: OPENING_USER_TEMPLATE(genre, seed) },
  ];

  // ── 1. Call DeepSeek with stream:true ──────────────────────────────────
  let dsResp;
  try {
    dsResp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 1.0,
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

  // ── 2. Set up a TransformStream to process SSE and re-stream to client ──
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const sseResponse = new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',   // disable nginx/edge buffering
      ...corsHeaders(),
    },
  });

  // ── 3. Background task: collect DeepSeek SSE → parse JSON → emit chars ──
  (async () => {
    const send = async (obj) => {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };

    try {
      // Accumulate the full JSON text from DeepSeek SSE delta chunks.
      let accumulated = '';
      const reader = dsResp.body.getReader();
      const lineDecoder = new TextDecoder();
      let leftover = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = leftover + lineDecoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        leftover = lines.pop(); // last line may be incomplete

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            const delta = evt?.choices?.[0]?.delta?.content;
            if (delta) accumulated += delta;
          } catch (_) {}
        }
      }
      // flush leftover
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

      // Parse the accumulated JSON.
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

      const title   = String(parsed.title   || '无名故事').slice(0, 40);
      const opening = String(parsed.opening || '').trim();
      const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const choices = rawChoices.map(c => String(c).trim()).filter(Boolean).slice(0, 4);

      if (!opening || choices.length < 2) {
        await send({ type: 'error', error: '模型返回内容不完整，请重试。' });
        return;
      }

      const state = {
        title,
        genre:       String(parsed.genre       || genre || '').slice(0, 40),
        protagonist: String(parsed.protagonist || '').slice(0, 120),
        setting:     String(parsed.setting     || '').slice(0, 200),
        summary:     String(parsed.summary     || '').slice(0, 200),
        history: [{ role: 'assistant', text: opening }],
      };

      // Stream the opening text character by character.
      for (const ch of opening) {
        await send({ type: 'char', char: ch });
      }

      // Final frame with all structural data.
      await send({ type: 'done', title, choices, state });
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
