// EdgeOne Pages Edge Function
// Route: POST /api/continue
//
// Continues an in-progress story.
// Request body:
// {
//   state:  { title, genre, protagonist, setting, summary, history: [{role,text}] },
//   action: string                // what the player chose or typed
// }
//
// Response JSON:
// {
//   ok: true,
//   data: {
//     narrative: string,          // next story beat (assistant text)
//     choices:   string[],        // next set of choices, or [] if the story has ended
//     ended:     boolean,         // true if this beat is an ending
//     state:     { ... }          // updated story-state to pass into the next request
//   }
// }

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

const SYSTEM_PROMPT = `你是一位才华横溢的互动小说作者，正在为一个文字冒险游戏续写故事。
你必须使用中文写作，第二人称"你"叙事。

写作守则：
- 每次推进的叙述应控制在 120-220 个汉字，分 2-3 个短段落（用 \\n\\n 分隔）。
- 自然承接玩家上一次的动作，让动作有真实而具体的后果（成功、失败、出乎意料、引发新冲突都可以）。
- 不要替玩家做下一步决定。每次推进末尾必须留下新的张力，让玩家想做出选择。
- 偶尔（约每 6-10 个回合一次）可以让故事到达一个自然的结局节点——胜利、悲剧、谜题被揭晓、或主角的命运被永久改写。
- 即使玩家输入的是"选项之外"的自由动作，也要尽量在世界观允许的范围内让它发生；如果动作完全荒谬或破坏沉浸感，可以让世界以合乎逻辑的方式拒绝它（例如物理上无法做到、或带来惩罚性后果），但不要训话玩家。

你必须始终只返回一个合法的 JSON 对象，不要加任何 Markdown 围栏或解释。`;

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

  let body;
  try {
    body = await context.request.json();
  } catch (_) {
    return jsonError('请求体必须是 JSON。', 400);
  }

  const action = String(body?.action || '').trim().slice(0, 500);
  if (!action) return jsonError('缺少 action 字段。', 400);

  const inState = body?.state || {};
  const history = Array.isArray(inState.history) ? inState.history : [];

  // Trim history so we don't blow up the context: keep the first beat (opening)
  // and the most recent ~10 beats.
  const trimmed =
    history.length > 12
      ? [history[0], { role: 'system', text: '……（中间情节省略）……' }, ...history.slice(-10)]
      : history;

  // Build the chat messages from the trimmed history.
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Inject the story bible as a hidden system note so the model stays consistent.
  const bible = [
    inState.title ? `故事标题：${inState.title}` : '',
    inState.genre ? `题材：${inState.genre}` : '',
    inState.protagonist ? `主角：${inState.protagonist}` : '',
    inState.setting ? `背景：${inState.setting}` : '',
    inState.summary ? `隐藏纲要（仅供你参考，不要直接复述）：${inState.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (bible) {
    messages.push({ role: 'system', content: bible });
  }

  for (const beat of trimmed) {
    if (beat.role === 'assistant') {
      messages.push({ role: 'assistant', content: beat.text });
    } else if (beat.role === 'user') {
      messages.push({ role: 'user', content: `玩家行动：${beat.text}` });
    } else {
      // 'system' notes about elided history
      messages.push({ role: 'system', content: beat.text });
    }
  }

  // The current player action + the JSON schema instruction.
  messages.push({
    role: 'user',
    content: `玩家行动：${action}

请续写故事的下一段，并返回如下严格的 JSON：
{
  "narrative": "下一段故事正文，120-220 个汉字，分 2-3 段，用 \\n\\n 分隔",
  "choices": ["选项 A（不超过 22 个汉字）", "选项 B", "选项 C", "选项 D"],
  "ended": false,
  "summary_update": "如果剧情发生了重要转折，用一句话更新隐藏纲要；否则留空字符串"
}

附加规则：
- choices 必须给出 3-4 个差异化的选项，分别代表不同性格/策略的反应。
- 只有当本段确实是结局时，才把 "ended" 设为 true，并把 "choices" 留空数组 []。
- 不要在 narrative 中复述玩家刚刚说的话。`,
  });

  let parsed;
  try {
    parsed = await callDeepSeekJSON(apiKey, messages, { temperature: 0.9, max_tokens: 1400 });
  } catch (err) {
    return jsonError(`续写故事失败：${err.message}`, 502);
  }

  const narrative = String(parsed.narrative || '').trim();
  const ended = Boolean(parsed.ended);
  const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choices = ended
    ? []
    : rawChoices.map((c) => String(c).trim()).filter(Boolean).slice(0, 4);

  if (!narrative) {
    return jsonError('模型返回的剧情为空，请重试。', 502);
  }
  if (!ended && choices.length < 2) {
    return jsonError('模型未返回足够的选项，请重试。', 502);
  }

  // Build the updated state to echo back to the client.
  const newHistory = [
    ...history,
    { role: 'user', text: action },
    { role: 'assistant', text: narrative },
  ];

  const newSummary =
    typeof parsed.summary_update === 'string' && parsed.summary_update.trim()
      ? parsed.summary_update.trim().slice(0, 200)
      : inState.summary || '';

  const outState = {
    title: inState.title || '',
    genre: inState.genre || '',
    protagonist: inState.protagonist || '',
    setting: inState.setting || '',
    summary: newSummary,
    history: newHistory,
  };

  return jsonResponse({
    ok: true,
    data: { narrative, choices, ended, state: outState },
  });
}

// ---------- helpers ----------

async function callDeepSeekJSON(apiKey, messages, opts = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.9,
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
