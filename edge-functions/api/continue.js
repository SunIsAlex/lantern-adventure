// EdgeOne Pages Edge Function
// Route: POST /api/continue
//
// Response: JSON
//   success: { "ok": true, "narrative": "...", "choices": [...],
//              "ended": false, "state": {...} }
//   error:   { "ok": false, "error": "..." }   (with HTTP 4xx/5xx)

import { createHandler, onRequestOptions, jsonError, INLINE_MARKUP_GUIDE } from '../_shared.js';

const SYSTEM_PROMPT = `你是互动小说作者，为文字冒险游戏续写。请严格按下面的 JSON 格式输出，不要加 Markdown 围栏或解释。

规则：
1. narrative 承接玩家动作给出具体后果，用第二人称"你"，120-200 汉字，2-3 段，段间用 \\n\\n。
2. 结尾留悬念，不替玩家做下一步决定。
3. choices 给 4 个差异化选项（≤20 字）。
4. 约每 8 回合可触发自然结局，此时 ended 设为 true，choices 设为 []。
5. 若玩家动作超出世界观，让世界合理拒绝，不要训话。

记忆维护规则（关键，每回合都要做）：
6. summary_update 必填，是当前完整剧情纲要（不是本回合摘要），累积、压缩、覆盖式更新——把已发生的关键事件、关键决定、地点变化、伏笔等串成一段连续叙述，≤300 字。每回合都要重写完整 summary，不要只追加。
7. characters_update 是当前完整人物名册（不是本回合新增），数组形式，最多 12 条。每条 {name, note}：name 用故事中实际出现的称呼（"老周的女人"而非"匿名 NPC"），note ≤80 字，记录关键身份、与主角的关系、未了结的事。即使本回合人物没出现，也要保留在名册中——他们随时可能再出场，模型必须记得他们是谁。
8. 不要在 narrative 中复述 summary 或人物简介。这些字段是给作者（模型自己）看的备忘录。

${INLINE_MARKUP_GUIDE}

EXAMPLE JSON OUTPUT:
{
  "narrative": "你举起[[name]]鲸油灯[[/name]]，光晕里浮出[[name]]阿七[[/name]]苍白的脸。\\n\\n他[[whisper]]极轻地开口[[/whisper]]：[[dialog]]你来晚了，林记的铺子已经空了三天[[/dialog]]。",
  "choices": ["问他林记发生了什么", "我后退一步", "我吹熄灯", "我把灯递给他"],
  "ended": false,
  "summary_update": "你受老张所托寻找失踪的林记掌柜。沿山道夜行至雾港，在港口酒馆遇见阿七——他似乎知道内情，提到林记铺子已空三天。",
  "characters_update": [
    {"name": "老张", "note": "委托人，雾港老药商。给了你一盏鲸油灯和林记的木牌。"},
    {"name": "林记掌柜", "note": "失踪三天的目标对象。山港人称他为讲信用的老好人。"},
    {"name": "阿七", "note": "酒馆遇到的年轻人，苍白脸色，似乎知道林记下落，态度神秘。"}
  ]
}

结局示例：
{
  "narrative": "灯芯爆出最后一缕火光，随即熄灭。\\n\\n你听见远处传来钟声，故事到此为止。",
  "choices": [],
  "ended": true,
  "summary_update": "（与上回合相同的完整纲要）",
  "characters_update": []
}`;

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
    const characters = Array.isArray(inState.characters) ? inState.characters : [];
    const trimmed = history.length > 12
      ? [history[0], { role: 'system', text: '……（中间情节省略）……' }, ...history.slice(-10)]
      : history;

    const userMessages = [];

    // Roster string built from the characters array. Format chosen to read
    // naturally as part of a Chinese system note rather than as JSON.
    const roster = characters.length
      ? characters
          .map(c => `- ${c?.name || '(无名)'}: ${c?.note || ''}`)
          .join('\n')
      : '';

    const bibleParts = [
      inState.title       ? `标题：${inState.title}`           : '',
      inState.genre       ? `题材：${inState.genre}`           : '',
      inState.protagonist ? `主角：${inState.protagonist}`     : '',
      inState.setting     ? `背景：${inState.setting}`         : '',
      inState.summary     ? `当前剧情纲要（勿复述，作者备忘）：\n${inState.summary}` : '',
      roster              ? `已登场人物名册（勿复述，作者备忘）：\n${roster}`     : '',
    ].filter(Boolean);
    const bible = bibleParts.join('\n\n');
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
      ? parsed.summary_update.trim().slice(0, 300)
      : inState.summary || '';

    // characters_update is the full latest roster. We trust the model to
    // carry forward names that still matter; if it returns the field but
    // empty, treat that as "no change" rather than "wipe everything" so a
    // single bad turn can't clear our memory.
    let newCharacters = Array.isArray(inState.characters) ? inState.characters : [];
    if (Array.isArray(parsed.characters_update) && parsed.characters_update.length > 0) {
      newCharacters = parsed.characters_update
        .filter(c => c && typeof c === 'object')
        .map(c => ({
          name: String(c.name || '').trim().slice(0, 40),
          note: String(c.note || '').trim().slice(0, 80),
        }))
        .filter(c => c.name)
        .slice(0, 12);
    }

    const outState = {
      title:       inState.title       || '',
      genre:       inState.genre       || '',
      protagonist: inState.protagonist || '',
      setting:     inState.setting     || '',
      summary:     newSummary,
      characters:  newCharacters,
      history: [...history, { role: 'user', text: action }, { role: 'assistant', text: narrative }],
    };

    return {
      body: { narrative, choices, ended, state: outState },
    };
  },
});
