// EdgeOne Pages Edge Function
// Route: POST /api/start
//
// Response: JSON
//   success: { "ok": true, "narrative": "...", "title": "...",
//              "choices": [...], "state": {...} }
//   error:   { "ok": false, "error": "..." }   (with HTTP 4xx/5xx)

import { createHandler, onRequestOptions } from '../_shared.js';

const SYSTEM_PROMPT = `你是互动小说作者，为文字冒险游戏写中文故事。规则：
1. 只返回合法 JSON，不加 Markdown 围栏或解释。
2. 叙述用第二人称"你"，120-200 汉字，2-3 段，段间用 \\n\\n。
3. 用感官细节开场，结尾留悬念，不替玩家做决定。`;

const OPENING_USER_TEMPLATE = (genre, seed) =>
  `生成文字冒险开场。${genre ? `题材：${genre}。` : '自选有趣题材。'}${seed ? `灵感：${seed}。` : ''}

返回 JSON：
{"title":"6-12字标题","genre":"题材标签","protagonist":"主角名+一句话身份","setting":"世界背景一句话","summary":"剧情纲要≤20字（玩家不可见）","opening":"开场正文120-200字2-3段","choices":["选项A≤20字","选项B","选项C","选项D"]}

选项4个，分别代表谨慎/激进/狡猾/意外，用"我…"或祈使句开头。`;

export { onRequestOptions };

export const onRequestPost = createHandler({
  model: 'deepseek-v4-pro',
  temperature: 1.0,
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
