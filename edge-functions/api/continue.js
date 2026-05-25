// EdgeOne Pages Edge Function
// Route: POST /api/continue
//
// Response: JSON
//   success: { "ok": true, "narrative": "...", "choices": [...],
//              "ended": false, "state": {...} }
//   error:   { "ok": false, "error": "..." }   (with HTTP 4xx/5xx)

import { createHandler, onRequestOptions, jsonError } from '../_shared.js';

const SYSTEM_PROMPT = `你是互动小说作者，续写文字冒险游戏。规则：
1. 只返回合法 JSON，不加 Markdown 围栏或解释。
2. 叙述用第二人称"你"，120-200 汉字，2-3 段，段间用 \\n\\n。
3. 承接玩家动作给出具体后果，结尾留悬念，不替玩家做下一步决定。
4. 约每 8 回合可触发自然结局，此时 ended:true，choices:[]。
5. 若玩家动作超出世界观，让世界合理拒绝，不要训话。`;

export { onRequestOptions };

export const onRequestPost = createHandler({
  model: 'deepseek-v4-flash',
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
      if      (beat.role === 'assistant') userMessages.push({ role: 'assistant', content: beat.text });
      else if (beat.role === 'user')      userMessages.push({ role: 'user',      content: `玩家行动：${beat.text}` });
      else                                userMessages.push({ role: 'system',    content: beat.text });
    }

    userMessages.push({
      role: 'user',
      content: `玩家行动：${action}

返回 JSON：
{"narrative":"续写正文120-200字2-3段","choices":["选项A≤20字","选项B","选项C","选项D"],"ended":false,"summary_update":""}

选项4个，差异化。结局时 ended:true，choices:[]。`,
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
