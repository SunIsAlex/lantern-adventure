// Shared helpers for the lantern-adventure Edge Functions.
//
// Routes:
//   - /api/narrate : Direct streaming proxy to DeepSeek V4 Pro. The client
//                    parses the OpenAI-format SSE itself. See narrate.js.
//   - /api/choices : Single JSON response, DeepSeek V4 Flash, structured
//                    output ({ choices, ended, meta | summary_update }).

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export const INLINE_MARKUP_GUIDE = `语义标记（用于叙事正文）：
- [[em]]…[[/em]]：强调
- [[dialog]]…[[/dialog]]：对白（标签自带引号，内部勿加 "" 「」）
- [[name]]…[[/name]]：人名 / 地名 / 关键物品首次出现
- [[sense]]…[[/sense]]：突出的感官细节
- [[whisper]]…[[/whisper]]：低语、远响、心声
- <<break>>：段内停顿，单标签无需闭合；段落换行用 \\n\\n

铁律：每个开标签必须有对应闭标签，标签名小写，只能用上述 6 种。漏闭合或拼错 = 整段作废。
用量：整段最多 4 处，不确定能否正确闭合就用纯文本。

用例：[[dialog]]你跟上来做什么？[[/dialog]] [[name]]岚城[[/name]]的夜风里，她的声音像一片落叶。

你刚开口，[[sense]]血腥味突然浓得像铁锈[[/sense]]。墙缝中渗出[[whisper]]别回头……别回头……[[/whisper]]

脚下一空。[[em]]整个世界倒转过来[[/em]] <<break>> 你抓住的只有湿冷的空气。`;

// ─── CORS ─────────────────────────────────────────────────────────────────
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ─── JSON helpers ─────────────────────────────────────────────────────────
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

export function jsonError(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

export function parseAssistantJSON(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const text = cleaned;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') continue;
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(text.slice(i, j + 1)); }
            catch (_) { break; }
          }
        }
      }
    }
    throw new Error(`模型返回的不是合法 JSON：${String(raw).slice(0, 200)}`);
  }
}

// ─── DeepSeek calls ───────────────────────────────────────────────────────
export async function callDeepSeekJSON({ apiKey, model, messages, temperature }) {
  return fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      stream: false,
      thinking: { type: 'disabled' },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 60000, writeTimeout: 5000 } },
  });
}

export async function callDeepSeekStream({ apiKey, model, messages, temperature }) {
  return fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 1500,
      stream: true,
      thinking: { type: 'disabled' },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });
}

// ─── Handler factory (JSON routes only) ───────────────────────────────────
export function createJSONHandler(config) {
  const { model, temperature, systemPrompt, buildRequest, finalize } = config;

  return async function onRequestPost(context) {
    const apiKey = context.env?.DEEPSEEK_API_KEY;
    if (!apiKey) return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);

    let built;
    try { built = await buildRequest(context); }
    catch (err) { return jsonError(err.message || '请求解析失败。', 400); }
    if (built instanceof Response) return built;

    const { userMessages, ctx } = built;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...userMessages,
    ];

    let dsResp;
    try {
      dsResp = await callDeepSeekJSON({ apiKey, model, messages, temperature });
    } catch (err) {
      return jsonError(`连接 DeepSeek 失败：${err.message}`, 502);
    }
    if (!dsResp.ok) {
      const t = await dsResp.text();
      return jsonError(`DeepSeek API ${dsResp.status}: ${t.slice(0, 200)}`, 502);
    }

    let dsJson;
    try { dsJson = await dsResp.json(); }
    catch (err) { return jsonError(`DeepSeek 响应解析失败：${err.message}`, 502); }

    const content = dsJson?.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = parseAssistantJSON(content); }
    catch (err) { return jsonError(err.message, 502); }

    let result;
    try { result = await finalize({ parsed, ctx }); }
    catch (err) { return jsonError(err.message || '处理响应失败。', 502); }
    if (result && result.error) return jsonError(result.error, 502);

    return jsonResponse({ ok: true, ...result.body });
  };
}