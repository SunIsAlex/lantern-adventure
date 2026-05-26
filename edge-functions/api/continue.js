// EdgeOne Pages Edge Function
// Route: POST /api/continue
//
// Response: JSON
//   success: { "ok": true, "narrative": "...", "choices": [...],
//              "ended": false, "state": {...} }
//   error:   { "ok": false, "error": "..." }   (with HTTP 4xx/5xx)

import { createHandler, onRequestOptions, jsonError, INLINE_MARKUP_GUIDE } from '../_shared.js';

const SYSTEM_PROMPT = `你是互动小说作者，为中文文字冒险游戏续写。严格按下方 JSON 输出，不加 Markdown 围栏或解释。

规则：
1. narrative：承接玩家动作，第二人称"你"，60-100 汉字，2-3 段，段间 \\n\\n。结尾留悬念，不替玩家决定。
2. choices：4 个差异化选项（≤20 字），纯文本。
3. 约每 8 回合可触发自然结局，ended=true 且 choices=[]。
4. 玩家动作超出世界观时，让世界合理拒绝，不训话。
5. 语义标记必须正确闭合，详见下方规则。

${INLINE_MARKUP_GUIDE}

EXAMPLE JSON OUTPUT:
{
  "narrative": "你举起鲸油灯，光晕里浮出一张苍白的脸。\\n\\n它极轻地开口：[[dialog]]你来晚了。[[/dialog]]",
  "choices": ["问它在等谁", "我后退一步", "我吹熄灯", "我递出灯"],
  "ended": false,
  "summary_update": "山道遇白脸鬼"
}

结局示例：
{
  "narrative": "灯芯爆出最后一缕火光，随即熄灭。\\n\\n远处传来钟声，故事到此为止。",
  "choices": [],
  "ended": true,
  "summary_update": ""
}`;

export { onRequestOptions };

export const onRequestPost = createHandler({
  model: 'deepseek-v4-pro',
  temperature: 0.9,
  systemPrompt: SYSTEM_PROMPT,

  buildRequest: async (context) => {
    let body;
    try { body = await context.request.json(); }
    catch (_) { return jsonError('请求体必须是 JSON。', 400); }

    const action = String(body?.action || '').trim().slice(0, 500);
    if (!action) return jsonError('缺少 action 字段。', 400);

    const inState = body?.state || {};
    const history = Array.isArray(inState.history) ? inState.history : [];
    const trimmed = history.length > 12
      ? [history[0], { role: 'system', text: '……（中间情节省略）……' }, ...history.slice(-10)]
      : history;

    const userMessages = [];

    const bible = [
      inState.title       ? `标题：${inState.title}`           : '',
      inState.genre       ? `题材：${inState.genre}`           : '',
      inState.protagonist ? `主角：${inState.protagonist}`     : '',
      inState.setting     ? `背景：${inState.setting}`         : '',
      inState.summary     ? `纲要（勿复述）：${inState.summary}` : '',
    ].filter(Boolean).join('\n');
    if (bible) userMessages.push({ role: 'system', content: bible });

    for (const beat of trimmed) {
      if (beat.role === 'assistant') {
        // Wrap as a minimal JSON object so the model sees its own prior
        // outputs as schema-shaped — otherwise after a few turns it tends to
        // drift back to plain prose, since the bare narrative strings in
        // history look nothing like the JSON object we keep asking for.
        userMessages.push({
          role: 'assistant',
          content: JSON.stringify({ narrative: beat.text }),
        });
      } else if (beat.role === 'user') {
        userMessages.push({ role: 'user', content: `玩家行动：${beat.text}` });
      } else {
        userMessages.push({ role: 'system', content: beat.text });
      }
    }

    userMessages.push({
      role: 'user',
      content: `玩家行动：${action}

请按上述 JSON 格式输出本回合。`,
    });

    return { userMessages, ctx: { action, inState, history } };
  },

  finalize: ({ parsed, ctx }) => {
    const { action, inState, history } = ctx;
    const narrative = String(parsed.narrative || '').trim();
    const ended = Boolean(parsed.ended);
    const choices = ended ? [] :
      (Array.isArray(parsed.choices) ? parsed.choices : [])
        .map(c => String(c).trim()).filter(Boolean).slice(0, 4);

    if (!narrative) return { error: '模型返回剧情为空，请重试。' };
    if (!ended && choices.length < 2) return { error: '模型未返回足够选项，请重试。' };

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

    return {
      body: { narrative, choices, ended, state: outState },
    };
  },
});
