// EdgeOne Pages Edge Function
// Route: POST /api/narrate
//
// Non-streaming version: DeepSeek V4 Pro is called with stream:false and the
// full narrative is returned as a single JSON payload. The client simulates
// a typewriter effect locally for pacing.
//
// Request body:
//   { state?, action?, genre?, seed? }
//   - no state    → opening turn. Optional genre/seed for theme.
//   - with state  → continuation turn. action required.
//
// Response:
//   success: { ok: true, narrative: "..." }
//   error:   { ok: false, error: "..." }   (with HTTP 4xx/5xx)

import {
  onRequestOptions,
  jsonError,
  callDeepSeekJSON,
  INLINE_MARKUP_GUIDE,
} from '../_shared.js';

export { onRequestOptions };

const OPENING_SYSTEM_PROMPT = `你是互动小说作者，为中文文字冒险游戏写开场。

规则：
1. 只输出纯文本叙事，不要任何 JSON、Markdown 围栏、解释或元信息。
2. 第二人称"你"，60-100 汉字，2-3 段。
3. 感官细节开场，结尾留悬念，不替玩家决定。
4. 可以使用下方语义标记，但每个开标签必须正确闭合，否则不要用。

${INLINE_MARKUP_GUIDE}`;

const CONTINUE_SYSTEM_PROMPT = `你是互动小说作者，为中文文字冒险游戏续写。

规则：
1. 只输出纯文本叙事，不要任何 JSON、Markdown 围栏、解释或元信息。
2. 承接玩家动作，第二人称"你"，60-100 汉字，2-3 段，段间空一行。
3. 结尾留悬念，不替玩家决定。
4. 玩家动作超出世界观时，让世界合理拒绝，不训话。
5. 约每 8 回合可以让故事走向自然结局；结局回合用一段收尾叙事即可，不要写"故事结束"这类元话语。
6. 可以使用下方语义标记，但每个开标签必须正确闭合，否则不要用。

${INLINE_MARKUP_GUIDE}`;

function buildOpeningMessages(genre, seed) {
  return [
    { role: 'system', content: OPENING_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `请写一段开场。${genre ? `题材：${genre}。` : '自选一个有趣的题材。'}` +
        `${seed ? `灵感参考：${seed}。` : ''}`,
    },
  ];
}

function buildContinueMessages(inState, action) {
  const messages = [{ role: 'system', content: CONTINUE_SYSTEM_PROMPT }];

  const bible = [
    inState.title       ? `标题:${inState.title}`            : '',
    inState.genre       ? `题材:${inState.genre}`            : '',
    inState.protagonist ? `主角:${inState.protagonist}`      : '',
    inState.setting     ? `背景:${inState.setting}`          : '',
    inState.summary     ? `纲要(勿复述):${inState.summary}`  : '',
  ].filter(Boolean).join('\n');
  if (bible) messages.push({ role: 'system', content: bible });

  const history = Array.isArray(inState.history) ? inState.history : [];
  const trimmed = history.length > 12
    ? [history[0], { role: 'system', text: '……(中间情节省略)……' }, ...history.slice(-10)]
    : history;

  for (const beat of trimmed) {
    if (beat.role === 'assistant') {
      messages.push({ role: 'assistant', content: beat.text });
    } else if (beat.role === 'user') {
      messages.push({ role: 'user', content: `玩家行动：${beat.text}` });
    } else {
      messages.push({ role: 'system', content: beat.text });
    }
  }

  messages.push({
    role: 'user',
    content: `玩家行动：${action}\n\n请续写这一回合。`,
  });

  return messages;
}

// callDeepSeekJSON in _shared.js sets response_format:{type:'json_object'},
// which we don't want here — narrate returns plain prose. So we call fetch
// directly with the same options minus that flag.
async function callDeepSeekPlainText({ apiKey, model, messages, temperature }) {
  return fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 1500,
      stream: false,
      thinking: { type: 'disabled' },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });
}

export async function onRequestPost(context) {
  const apiKey = context.env?.DEEPSEEK_API_KEY;
  if (!apiKey) return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);

  let body = {};
  try { body = await context.request.json(); } catch (_) {}

  const hasState = body && body.state && typeof body.state === 'object';
  let messages;
  let temperature;

  if (hasState) {
    const action = String(body.action || '').trim().slice(0, 500);
    if (!action) return jsonError('缺少 action 字段。', 400);
    messages = buildContinueMessages(body.state, action);
    temperature = 0.9;
  } else {
    const genre = typeof body.genre === 'string' ? body.genre.slice(0, 40) : '';
    const seed  = typeof body.seed  === 'string' ? body.seed.slice(0, 200) : '';
    messages = buildOpeningMessages(genre, seed);
    temperature = 1.1;
  }

  let dsResp;
  try {
    dsResp = await callDeepSeekPlainText({
      apiKey,
      model: 'deepseek-v4-pro',
      messages,
      temperature,
    });
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

  const narrative = String(dsJson?.choices?.[0]?.message?.content || '').trim();
  if (!narrative) return jsonError('模型返回叙事为空，请重试。', 502);

  return new Response(JSON.stringify({ ok: true, narrative }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}