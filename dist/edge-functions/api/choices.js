// EdgeOne Pages Edge Function
// Route: POST /api/choices
//
// Given the narration that was just streamed by /api/narrate (plus the prior
// state, if any), ask DeepSeek V4 Flash to produce four differentiated player
// choices, decide whether the story has ended, and — on the first turn —
// extract the story bible (title/genre/protagonist/setting/summary).
//
// Request body:
//   { narration: string,            // the narration text the player just saw
//     action?:   string,            // present on continuation turns only
//     state?:    object,            // present on continuation turns only
//     seed?:     string,            // first turn only, for context
//     genre?:    string }           // first turn only, for context
//
// Response (success):
//   First turn:
//     { ok: true, choices: [...], ended: bool,
//       meta: { title, genre, protagonist, setting, summary } }
//   Continuation turn:
//     { ok: true, choices: [...], ended: bool, summary_update: string }

import { createJSONHandler, jsonError } from '../_shared.js';

const OPENING_SYSTEM_PROMPT = `你是互动小说的玩法设计师。根据给定的开场叙事，提取故事元数据并设计 4 个开局选项。

严格按下方 JSON 输出，不加 Markdown 围栏或解释：

{
  "title": "≤20 字的故事名",
  "genre": "题材标签",
  "protagonist": "主角一句话",
  "setting": "背景一句话",
  "summary": "一句对玩家不可见的剧情纲要",
  "choices": ["选项1", "选项2", "选项3", "选项4"],
  "ended": false
}

choices 规则：4 个差异化选项，分别代表谨慎/激进/狡猾/意外；每个 ≤20 字，纯文本（不要标记符号）；用"我…"或祈使句开头。
ended：开场永远为 false。`;

const CONTINUE_SYSTEM_PROMPT = `你是互动小说的玩法设计师。根据故事上下文和最新一段叙事，设计 4 个差异化的后续选项，并判断故事是否到达自然结局。

严格按下方 JSON 输出，不加 Markdown 围栏或解释：

{
  "choices": ["选项1", "选项2", "选项3", "选项4"],
  "ended": false,
  "summary_update": "一句更新后的剧情纲要（对玩家不可见，可与原纲要相同）"
}

choices 规则：
- 4 个差异化选项，分别代表谨慎/激进/狡猾/意外。
- 每个 ≤20 字，纯文本（不要使用 [[...]] 或 <<...>> 之类的标记）。
- 用"我…"或祈使句开头。
- 选项要与最新叙事呼应，但不要剧透下一步。

ended 规则：
- 如果最新叙事已经写出了明确的收束（角色死亡、目标完成、世界毁灭、长夜尽头等），返回 true 并把 choices 设为空数组 []。
- 否则返回 false。`;

// History trimming for the Flash prompt. Same shape as narrate's trimming,
// so Flash sees the same context Pro saw.
function trimmedHistoryAsText(state) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const trimmed = history.length > 12
    ? [history[0], { role: 'system', text: '……（中间情节省略）……' }, ...history.slice(-10)]
    : history;
  return trimmed.map(b => {
    if (b.role === 'assistant') return `【叙事】${b.text}`;
    if (b.role === 'user')      return `【玩家行动】${b.text}`;
    return `【备注】${b.text}`;
  }).join('\n\n');
}

// ─── First turn ─────────────────────────────────────────────────────────────
const openingHandler = createJSONHandler({
  model: 'deepseek-v4-flash',
  temperature: 0.7,
  systemPrompt: OPENING_SYSTEM_PROMPT,

  buildRequest: async (context) => {
    const body = context.__parsedBody;
    const narration = String(body.narration || '').trim();
    if (!narration) throw new Error('缺少 narration 字段。');
    const genre = String(body.genre || '').slice(0, 40);
    const seed  = String(body.seed  || '').slice(0, 200);

    const userParts = [];
    if (genre) userParts.push(`玩家选择的题材：${genre}`);
    if (seed)  userParts.push(`玩家给的灵感：${seed}`);
    userParts.push(`开场叙事原文：\n${narration}`);
    userParts.push('请按上述 JSON 格式输出。');

    return {
      userMessages: [{ role: 'user', content: userParts.join('\n\n') }],
      ctx: { narration },
    };
  },

  finalize: ({ parsed }) => {
    const choices = sanitizeChoices(parsed.choices);
    if (choices.length < 2) return { error: '模型未返回足够的开局选项，请重试。' };

    const meta = {
      title:       String(parsed.title       || '无名故事').slice(0, 40),
      genre:       String(parsed.genre       || '').slice(0, 40),
      protagonist: String(parsed.protagonist || '').slice(0, 120),
      setting:     String(parsed.setting     || '').slice(0, 200),
      summary:     String(parsed.summary     || '').slice(0, 200),
    };

    return {
      body: { choices, ended: false, meta },
    };
  },
});

// ─── Continuation turn ──────────────────────────────────────────────────────
const continueHandler = createJSONHandler({
  model: 'deepseek-v4-flash',
  temperature: 0.7,
  systemPrompt: CONTINUE_SYSTEM_PROMPT,

  buildRequest: async (context) => {
    const body = context.__parsedBody;
    const narration = String(body.narration || '').trim();
    if (!narration) throw new Error('缺少 narration 字段。');
    const action = String(body.action || '').trim().slice(0, 500);
    if (!action) throw new Error('缺少 action 字段。');

    const state = body.state || {};
    const bibleParts = [
      state.title       ? `标题：${state.title}`            : '',
      state.genre       ? `题材：${state.genre}`            : '',
      state.protagonist ? `主角：${state.protagonist}`      : '',
      state.setting     ? `背景：${state.setting}`          : '',
      state.summary     ? `纲要：${state.summary}`          : '',
    ].filter(Boolean).join('\n');

    const historyText = trimmedHistoryAsText(state);

    const userContent = [
      bibleParts && `故事档案：\n${bibleParts}`,
      historyText && `已发生：\n${historyText}`,
      `玩家本回合行动：${action}`,
      `本回合最新叙事：\n${narration}`,
      '请按上述 JSON 格式输出本回合的选项。',
    ].filter(Boolean).join('\n\n');

    return {
      userMessages: [{ role: 'user', content: userContent }],
      ctx: { state },
    };
  },

  finalize: ({ parsed, ctx }) => {
    const ended = Boolean(parsed.ended);
    const choices = ended ? [] : sanitizeChoices(parsed.choices);
    if (!ended && choices.length < 2) {
      return { error: '模型未返回足够的选项，请重试。' };
    }
    const newSummary = (typeof parsed.summary_update === 'string' && parsed.summary_update.trim())
      ? parsed.summary_update.trim().slice(0, 200)
      : (ctx.state.summary || '');

    return {
      body: { choices, ended, summary_update: newSummary },
    };
  },
});

function sanitizeChoices(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(c => String(c).trim())
    // Defensive: strip any leaked markup tokens.
    .map(c => c.replace(/\[\[\/?[a-z]+\]\]|<<\/?[a-z]+>>/g, ''))
    .map(c => c.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// ─── Router: dispatch by whether state is present ───────────────────────────
//
// `createJSONHandler` reads the request body via `buildRequest`. We need to
// peek at it first to choose between the two handlers, then hand the parsed
// body through `context.__parsedBody` so neither handler re-reads the stream.
export { onRequestOptions } from '../_shared.js';

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); }
  catch (_) { return jsonError('请求体必须是 JSON。', 400); }

  context.__parsedBody = body;

  if (body && body.state) return continueHandler(context);
  return openingHandler(context);
}