# 提灯人 · 文字冒险游戏（EdgeOne Pages 版）

一个部署在 **EdgeOne Pages** 上、由 **DeepSeek V4** 驱动的中文交互式文字冒险游戏。
开场由 AI 即兴生成；之后每一回合，AI 给出 4 个差异化的选项让你选，**也可以输入选项之外的自由动作**。

灵感来源：AI Dungeon，但保留了明确的选项作为主要交互方式。

---

## 一、项目结构

```
.
├─ index.html                  # 前端单页 + 首屏关键 CSS（暗色羊皮纸风格）
├─ styles.css                  # 游戏视图的非关键 CSS
├─ app.js                      # 前端逻辑（IIFE，不依赖任何框架）
├─ edgeone.json                # EdgeOne Pages 构建配置（maxDuration 等）
├─ edge-functions/
│  ├─ _shared.js               # CORS、DeepSeek 调用、JSON 解析、handler 工厂
│  └─ api/
│     ├─ narrate.js            # POST /api/narrate  —— 由 Pro 写一段叙事
│     └─ choices.js            # POST /api/choices  —— 由 Flash 生成 4 个选项
└─ README.md
```

- **静态资源**（`index.html` / `styles.css` / `app.js`）由 EdgeOne 全球节点托管。`app.js` 在 `<head>` 里以 `defer` 加载，能与 HTML 并行下载；首屏关键 CSS 内联在 `<head>` 避免 FOUC，游戏中才出现的样式放外部 `styles.css`。
- **后端逻辑**完全跑在 EdgeOne Pages 的 **Edge Functions** 上，文件结构即路由：
  - `/edge-functions/api/narrate.js` → `https://你的域名/api/narrate`
  - `/edge-functions/api/choices.js` → `https://你的域名/api/choices`
- **每个回合都是两段式调用**：先调 `/api/narrate` 拿叙事正文（由 DeepSeek V4 Pro 直接吐纯文本），再调 `/api/choices` 拿 4 个选项 + 故事元数据（由 DeepSeek V4 Flash 输出 JSON）。两段分开的好处：叙事不必塞进 JSON schema，模型不会因为转义引号、混排 Markdown 等小毛病整段作废；选项用更便宜的 Flash 模型生成，整体成本下降。
- DeepSeek 的 API Key 通过 **环境变量** `DEEPSEEK_API_KEY` 注入，**不会出现在前端代码里**。

---

## 二、本地准备

把上面这些文件原样放到一个 Git 仓库（或者用 `edgeone` CLI 直接上传也行）。

如果你想在本地预览，安装 EdgeOne CLI 后：

```bash
npm i -g edgeone
edgeone login
edgeone pages init        # 第一次在仓库里初始化
edgeone pages dev         # 本地起调试服务
```

调试时记得在项目根目录建一个 `.env` 文件（不要提交到 Git）：

```env
DEEPSEEK_API_KEY=你的_DeepSeek_API_Key
```

---

## 三、部署到 EdgeOne Pages

### 方式 A：从 Git 仓库导入（推荐）

1. 把项目推到 GitHub / GitLab / Gitee。
2. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone/pages)。
3. **创建项目 → 导入 Git 仓库**，选中本仓库。
4. 构建设置全部留空（这是个纯静态 + Edge Functions 项目，不需要 build 命令）。
5. 点击 **部署**。

### 方式 B：直接上传

把整个项目文件夹拖到 [pages.edgeone.ai/drop](https://pages.edgeone.ai/drop)，或者：

```bash
edgeone pages deploy . -n lantern-adventure
```

---

## 四、配置环境变量（**必须！**）

部署后，在 **EdgeOne 控制台 → 你的项目 → 设置 → 环境变量** 里添加：

| 变量名              | 值                                       |
| ------------------- | ---------------------------------------- |
| `DEEPSEEK_API_KEY`  | 你的 DeepSeek API Key（以 `sk-` 开头）   |

保存后，**重新部署一次**让环境变量生效。

> Edge Function 里的访问方式是 `context.env.DEEPSEEK_API_KEY`，前端 JS **完全接触不到** 这个 Key。

---

## 五、API 说明

两段式调用，都是普通的 JSON 请求-响应（详见"七、关于流式输出"）。

### `POST /api/narrate`

由 DeepSeek V4 Pro 写一段叙事正文。

**请求体**——无 state 视为开场回合：

```json
{ "genre": "蒸汽朋克悬疑", "seed": "一只会说话的乌鸦" }
```

带 state 视为续写回合：

```json
{
  "state":  { "title": "...", "history": [...], "summary": "..." },
  "action": "我悄悄绕到柱子后面"
}
```

`action` 可以是上一轮 `choices` 里的某一项，**也可以是任何自由文本**。

**成功响应**：

```json
{ "ok": true, "narrative": "故事正文（带 \\n\\n 分段，可能含内联标记）" }
```

### `POST /api/choices`

由 DeepSeek V4 Flash 在叙事文本基础上生成 4 个差异化选项，并判断本回合是否到达自然结局。

**请求体**——开场回合（无 state 传入）：

```json
{
  "narration": "刚由 /api/narrate 拿到的叙事原文",
  "genre":     "蒸汽朋克悬疑",
  "seed":      "一只会说话的乌鸦"
}
```

**响应**会同时返回从叙事里抽取的故事元数据：

```json
{
  "ok": true,
  "choices": ["选项 A", "选项 B", "选项 C", "选项 D"],
  "ended":   false,
  "meta": {
    "title":       "故事标题",
    "genre":       "题材标签",
    "protagonist": "主角一句话",
    "setting":     "背景一句话",
    "summary":     "对玩家不可见的剧情纲要"
  }
}
```

续写回合（带 state）：

```json
{
  "narration": "本回合刚拿到的叙事原文",
  "action":    "玩家本回合的行动",
  "state":     { "...": "整段 state 原样传入" }
}
```

**响应**：

```json
{
  "ok": true,
  "choices":        ["...", "..."],
  "ended":          false,
  "summary_update": "一句更新后的剧情纲要"
}
```

当 `ended` 为 `true` 时 `choices` 为空数组，前端会显示 "F I N" 收尾印。

### 错误响应（两个 route 通用）

```json
{ "ok": false, "error": "可读的中文错误描述" }
```

附带相应的 HTTP 4xx / 5xx 状态码。常见错误：未配置 `DEEPSEEK_API_KEY`（500）、请求体缺 `action` 或 `narration`（400）、DeepSeek 返回非合法 JSON（502，仅 `/api/choices`）。

---

## 六、前端特色功能

### 自动存档

每次完成一回合，整段状态会以 JSON 形式写进 `localStorage`，刷新页面或关闭重开浏览器都能继续。

### 分享链接

右上角"分享当前进度"会把整个 state 经过 `CompressionStream('deflate-raw')` + base64url 压缩，写进 URL 的 hash 片段（`#…`）—— 不走查询字符串是为了避免被服务器或 CDN 日志记录。分享链接的体积大致是裸 JSON 的 30–40%，正常一局玩到 8–10 回合还能装得下。

### 语义内联标记

模型可以在叙事正文中嵌入以下白名单标记，前端会渲染成带样式的 `<span>`：

| 标记 | 含义 |
| --- | --- |
| `[[EM]]…[[/EM]]` | 强调关键词 / 转折 |
| `[[DIALOG]]…[[/DIALOG]]` | 直接引语 / 对白（标签自带引号） |
| `[[NAME]]…[[/NAME]]` | 人名 / 地名 / 关键物品 |
| `[[SENSE]]…[[/SENSE]]` | 突出感官细节 |
| `[[WHISPER]]…[[/WHISPER]]` | 环境低语 / 心声 |
| `<<BREAK>>` | 段内停顿（自闭合） |

为什么大写：在中文叙事里大写字母几乎不会出现，作为"控制标签"语义最清晰，模型也最不容易把它和正文里的修饰性强调搞混。

**前端容错**：解析正则同时接受 `[[XX]]`、`<<XX>>`、`{{XX}}` 三种括号形式（模型偶尔会输错括号），也同时接受大小写——CSS 类名一律转成小写，所以 `[[em]]` / `[[Em]]` / `[[EM]]` 都会渲染出 `<span class="tag-em">`。

**安全模型**：解析路径**零 `innerHTML`**，全部用 `createElement` + `textContent`。命中白名单的开标签压栈生成 `<span class="tag-X">`，其它任何 token（含属性的伪标签、未闭合的、非白名单的标签名、HTML 注入尝试）一律降级为字面字符。新生成的回合和从分享链接 / 本地存档恢复出来的历史都走同一条解析路径。

### 客户端打字机

叙事拿到后用客户端打字机把字符一段段渲染（默认 35ms / 2 字符）。**遇到未闭合的标记 token 会暂停**，等闭合括号到达再一次性把整段带格式的内容"啪"地闪现——视觉上的写作感不亚于真流式。

### 灯笼摇曳的等待状态

"笔尖正在润墨..." 字样有一个 3.2 秒一周期、关键帧不规则（14/29/42/57/71/85%）的 `lantern-flicker` 动画，叠加 `text-shadow` 暖色光晕，模拟烛火被气流扰动。

---

## 七、关于流式输出

我们曾经尝试把 `/api/narrate` 做成真正的 SSE 流式接口——服务端用 `stream: true` 调 DeepSeek，再把上游 chunk 透传给浏览器，让玩家看到字一个一个浮出来。

**服务端确实是流式的**：用 `curl --no-buffer` 能看到 chunk 按 DeepSeek 实际吐 token 的节奏到达。但所有浏览器路径（fetch + ReadableStream、EventSource、本地开发服务、生产环境）都呈现"前面静默几秒 + 最后一波刷完"的批量行为，根因在浏览器到服务端之间的某一层（最可能是网络中间设备的缓冲或 HTTP/2 帧聚合），未根治。

最终回退为：服务端拿到完整叙事一次性 JSON 返回，前端用打字机模拟。代价是开场要多等 4-5 秒拿到完整叙事，体验上靠打字机动画来缓和。

如果未来想再次尝试真流式，关键代码（DeepSeek 的 stream 调用、SSE 透传）在 `_shared.js` 的 `callDeepSeekStream` 里还保留着，可以作为起点。

---

## 八、设计要点 / 可以怎么改

- **故事连贯性**：`/api/narrate`（续写时）和 `/api/choices` 都会把 state.history 按"开场 + 中段省略 + 最近 10 回合"做一次压缩（阈值 12 回合），既保连贯又防爆上下文。
- **隐藏纲要**：`state.summary` 是一句对玩家不可见的剧情纲要，Flash 在每个回合通过 `summary_update` 字段更新它，用来保持长程一致性。
- **选项之外的动作**：自由输入被当成 `玩家行动：xxx` 喂给模型，prompt 明确允许 AI 让不合常理的动作以合乎物理 / 世界观的方式失败，避免破坏沉浸感。
- **模型与温度**：
  - `narrate.js` 用 `deepseek-v4-pro` + `temperature=1.1`（开场，鼓励多样开局）/ `0.9`（续写，鼓励连贯性）
  - `choices.js` 用 `deepseek-v4-flash` + `temperature=0.7`（更便宜，选项足够多样即可）
  - 替换模型只需改对应文件顶部 `model` 字段。想要更稳定的故事调低温度，想更狂野调到 `1.1+`。
- **结局判定由 Flash 负责**：Pro 不需要知道"是否到结局"，只负责写一段收尾叙事；Flash 在生成选项时若判定本回合已自然收束，会返回 `ended: true` + `choices: []`，前端据此显示 F I N。
- **JSON 模式只用在 choices**：`/api/choices` 调用 DeepSeek 时使用 `response_format: { type: 'json_object' }`，配合带 `EXAMPLE` 的 system prompt（[DeepSeek 官方推荐用法](https://api-docs.deepseek.com/zh-cn/guides/json_mode)）。`/api/narrate` 完全是纯文本输出，从根本上避开了"模型偶尔吐非法 JSON 把整回合搞砸"的失败模式。

---

## 九、注意事项

- Edge Functions 的 CPU 时间限额、并发上限、单次执行最大时长等运行时约束以 [EdgeOne Pages 官方文档](https://edgeone.cloud.tencent.com/pages/document/) 为准。本项目里 `edgeone.json` 设置 `maxDuration: 120` 是为了给 DeepSeek 慢响应留足够空间。
- DeepSeek 的实时定价、模型可用性、折扣以 [DeepSeek 计费文档](https://api-docs.deepseek.com/quick_start/pricing) 为准。
- 当前实现没有任何服务端持久化，所有状态都在浏览器（localStorage + URL）。需要"账号 / 跨设备存档"功能可以接入 EdgeOne Pages 的 KV / D1 之类，把 `state` 持久化到边缘。
