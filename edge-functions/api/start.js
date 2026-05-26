// EdgeOne Pages Edge Function
// Route: POST /api/start
//
// Response: JSON
//   success: { "ok": true, "narrative": "...", "title": "...",
//              "choices": [...], "state": {...} }
//   error:   { "ok": false, "error": "..." }   (with HTTP 4xx/5xx)

import { createHandler, onRequestOptions, INLINE_MARKUP_GUIDE } from '../_shared.js';

const SYSTEM_PROMPT = `你是互动小说作者，为中文文字冒险游戏写开场。请严格按下面的 JSON 格式输出，不加 Markdown 围栏或解释。

规则：
1. opening 用第二人称"你"，120-200 汉字，2-3 段。
2. 用感官细节开场，结尾留悬念，不替玩家做决定。
3. choices 给 4 个差异化选项（≤20 字），分别代表谨慎/激进/狡猾/意外，用"我…"或祈使句开头。

${INLINE_MARKUP_GUIDE}

EXAMPLE JSON OUTPUT:
{
  "title": "雾港夜灯",
  "genre": "志怪",
  "protagonist": "阿野，年轻夜行人",
  "setting": "雾锁山港，提灯不可灭",
  "summary": "寻人，遇山鬼",
  "opening": "夜半。你提着[[name]]鲸油灯[[/name]]走入山道，雾从脚边漫起，浸湿了裤脚。\\n\\n远处传来一声[[whisper]]极轻的叹息[[/whisper]]，像有人在你耳边吹气。",
  "choices": ["举灯照向声音来处", "我吹熄灯，静立不动", "我低声答话试探", "退回港口"]
}`;

const OPENING_USER_TEMPLATE = (genre, seed) =>
  `生成一个新的开场。${genre ? `题材：${genre}。` : '自选一个有趣题材。'}${seed ? `灵感参考：${seed}。` : ''}

请按上述 JSON 格式输出。`;

export { onRequestOptions };

export const onRequestPost = createHandler({
  model: 'deepseek-v4-flash',
  temperature: 1.1,
  systemPrompt: SYSTEM_PROMPT,

  buildRequest: async (context) => {
    let body = {};
    try { body = await context.request.json(); } catch (_) {}
    const genre = typeof body.genre === 'string' ? body.genre.slice(0, 40) : '';
    const seed  = typeof body.seed  === 'string' ? body.seed.slice(0, 200) : '';
    return {
      userMessages: [
        { role: 'user', content: OPENING_USER_TEMPLATE(genre, seed) },
      ],
      ctx: { genre },
    };
  },

  finalize: ({ parsed, ctx }) => {
    const title   = String(parsed.title   || '无名故事').slice(0, 40);
    const opening = String(parsed.opening || '').trim();
    const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const choices = rawChoices.map(c => String(c).trim()).filter(Boolean).slice(0, 4);

    if (!opening || choices.length < 2) {
      return { error: '模型返回内容不完整，请重试。' };
    }

    const state = {
      title,
      genre:       String(parsed.genre       || ctx.genre || '').slice(0, 40),
      protagonist: String(parsed.protagonist || '').slice(0, 120),
      setting:     String(parsed.setting     || '').slice(0, 200),
      summary:     String(parsed.summary     || '').slice(0, 200),
      history: [{ role: 'assistant', text: opening }],
    };

    return {
      body: { narrative: opening, title, choices, state },
    };
  },
});
