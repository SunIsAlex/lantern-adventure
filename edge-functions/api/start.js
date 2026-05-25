// EdgeOne Pages Edge Function
// Route: POST /api/start
//
// Generates the opening of a new text-adventure story.
// Optional request body: { genre?: string, seed?: string }
//
// Response JSON:
// {
//   ok: true,
//   data: {
//     title: string,
//     opening: string,        // the opening passage (2-4 short paragraphs)
//     choices: string[],      // 3-4 short choice labels for the player
//     state: {                // opaque story-state, echoed back on /api/continue
//       title, genre, summary, protagonist, setting, history: [{role, text}]
//     }
//   }
// }

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

const SYSTEM_PROMPT = `你是一位才华横溢的互动小说作者，正在为一个文字冒险游戏（类似 AI Dungeon）撰写故事。
你必须严格使用中文写作，文笔要有画面感、有悬念、有节奏。
每一段叙述应当：
- 控制在 120-220 个汉字之间，分成 2-3 个短段落，便于在手机上阅读；
- 以场景感官细节开场（光线、气味、声响、触感），避免直接给人物心理活动下结论；
- 在段落末尾留下张力或未解的悬念，让玩家产生选择的冲动；
- 不要替玩家决定主角的对话或长远计划——把决定权留给选项。

你必须始终只返回一个合法的 JSON 对象，不要加任何 Markdown 围栏、不要加解释文字。`;

const OPENING_USER_TEMPLATE = (genre, seed) => `请为一个全新的文字冒险游戏生成开场。

要求：
- 风格/题材：${genre || '随机挑选一个有趣的类型（赛博朋克、蒸汽朋克、克苏鲁、武侠、太空歌剧、北欧神话、末日废土、维多利亚悬疑等等任选其一）'}
- 主角应当是一个具体的、有名字的人物，并暗示其当前处境（不要在开场就交代过多背景）。
- 开场要把玩家直接放进场景里，使用第二人称"你"。
${seed ? `- 玩家提供的灵感种子：${seed}` : ''}

返回如下严格的 JSON 结构：
{
  "title": "故事标题（6-14 个汉字）",
  "genre": "题材简短标签，如 '蒸汽朋克悬疑'",
  "protagonist": "主角姓名与一句话身份描述",
  "setting": "故事发生的世界与时代，一两句话",
  "summary": "30 字以内的隐藏剧情纲要，玩家看不到，仅用于保持后续故事连贯",
  "opening": "开场叙述正文，120-220 个汉字，分 2-3 段，段落之间用换行 \\n\\n 分隔",
  "choices": ["选项 A（不超过 22 个汉字）", "选项 B", "选项 C", "选项 D"]
}

选项要求：
- 4 个选项，彼此风格/后果迥异（谨慎/激进/狡猾/出人意料），不要全是动作类。
- 用第一人称"我"开头或祈使句，例如 "我悄悄绕到柱子后面" / "大声呼喊守卫"。`;

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

export async function onRequestPost(context) {
  const apiKey = context.env?.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonError('服务器未配置 DEEPSEEK_API_KEY 环境变量。', 500);
  }

  let body = {};
  try {
    body = await context.request.json();
  } catch (_) {
    // empty body is fine
  }
  const genre = typeof body.genre === 'string' ? body.genre.slice(0, 40) : '';
  const seed = typeof body.seed === 'string' ? body.seed.slice(0, 200) : '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: OPENING_USER_TEMPLATE(genre, seed) },
  ];

  let parsed;
  try {
    parsed = await callDeepSeekJSON(apiKey, messages, { temperature: 1.0, max_tokens: 1400 });
  } catch (err) {
    return jsonError(`生成开场失败：${err.message}`, 502);
  }

  // Validate & shape the response.
  const title = String(parsed.title || '无名故事').slice(0, 40);
  const opening = String(parsed.opening || '').trim();
  const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choices = rawChoices
    .map((c) => String(c).trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!opening || choices.length < 2) {
    return jsonError('模型返回的内容不完整，请重试。', 502);
  }

  const state = {
    title,
    genre: String(parsed.genre || genre || '未指定').slice(0, 40),
    protagonist: String(parsed.protagonist || '').slice(0, 120),
    setting: String(parsed.setting || '').slice(0, 200),
    summary: String(parsed.summary || '').slice(0, 200),
    history: [
      // Save the opening as the first "assistant" beat so /api/continue can keep context.
      { role: 'assistant', text: opening },
    ],
  };

  return jsonResponse({
    ok: true,
    data: { title, opening, choices, state },
  });
}

// ---------- helpers (inlined; Edge Functions exposes every file as a route, so
// we avoid cross-file imports) ----------

async function callDeepSeekJSON(apiKey, messages, opts = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.95,
    max_tokens: opts.max_tokens ?? 1400,
    response_format: { type: 'json_object' },
    stream: false,
  };

  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回内容为空。');

  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('DeepSeek 返回的不是合法 JSON。');
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonError(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}
