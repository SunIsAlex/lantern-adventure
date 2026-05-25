// Shared helpers for the lantern-adventure Edge Functions.
//
// Both /api/start and /api/continue follow the same shape:
//   1. Parse the request, build chat messages.
//   2. Call DeepSeek (non-streaming) and wait for the full response.
//   3. Parse the resulting JSON and return a single JSON response.
//   4. Handle the same set of CORS + error responses.
//
// Each route plugs its specifics into `createHandler(config)`:
//   - model / temperature
//   - systemPrompt
//   - buildRequest(context)  →  { userMessages, ctx }   (or a Response to short-circuit)
//   - finalize({ parsed, ctx })
//        →  { body }    (200 with { ok:true, ...body })
//        →  { error }   (502 with { ok:false, error })
//
// The shared module owns everything else.

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

export function jsonError(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ─── DeepSeek call (non-streaming) ────────────────────────────────────────
async function callDeepSeek({ apiKey, model, messages, temperature }) {
  return fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      stream: false,
      thinking: { type: 'disabled' },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });
}

// ─── Parse the assistant's JSON content, tolerating markdown fences ───────
function parseAssistantJSON(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('DeepSeek 返回的不是合法 JSON。');
  }
}

// ─── Public: build an onRequestPost from per-route config ─────────────────
export function createHandler(config) {
  const {
    model,
    temperature,
    systemPrompt,
    buildRequest,
    finalize,
  } = config;

  return async function onRequestPost(context) {
    const apiKey = context.env?.DEEPSEEK_API_KEY;
    if (!apiKey) return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);

    // Per-route request parsing. buildRequest may return a Response directly
    // to short-circuit (e.g. on bad input).
    let built;
    try {
      built = await buildRequest(context);
    } catch (err) {
      return jsonError(err.message || '请求解析失败。', 400);
    }
    if (built instanceof Response) return built;
    const { userMessages, ctx } = built;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...userMessages,
    ];

    // Call DeepSeek and read the full body.
    let dsResp;
    try {
      dsResp = await callDeepSeek({ apiKey, model, messages, temperature });
    } catch (err) {
      return jsonError(`连接 DeepSeek 失败：${err.message}`, 502);
    }
    if (!dsResp.ok) {
      const t = await dsResp.text();
      return jsonError(`DeepSeek API ${dsResp.status}: ${t.slice(0, 200)}`, 502);
    }

    let dsJson;
    try {
      dsJson = await dsResp.json();
    } catch (err) {
      return jsonError(`DeepSeek 响应解析失败：${err.message}`, 502);
    }

    const content = dsJson?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = parseAssistantJSON(content);
    } catch (err) {
      return jsonError(err.message, 502);
    }

    // Per-route validation and shaping.
    let result;
    try {
      result = await finalize({ parsed, ctx });
    } catch (err) {
      return jsonError(err.message || '处理响应失败。', 502);
    }
    if (result && result.error) return jsonError(result.error, 502);

    return jsonResponse({ ok: true, ...result.body });
  };
}
