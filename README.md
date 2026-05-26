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
│  ├─ _shared.js               # CORS、DeepSeek 调用、JSON 解析等公共逻辑
│  └─ api/
│     ├─ start.js              # POST /api/start    —— 生成开场
│     └─ continue.js           # POST /api/continue —— 推进故事
└─ README.md
```

- **静态资源**（`index.html` / `styles.css` / `app.js`）由 EdgeOne 全球节点托管。`app.js` 在 `<head>` 里以 `defer` 加载，能与 HTML 并行下载；首屏关键 CSS 内联在 `<head>` 避免 FOUC，游戏中才出现的样式放外部 `styles.css`。
- **后端逻辑**完全跑在 EdgeOne Pages 的 **Edge Functions** 上，文件结构即路由：
  - `/edge-functions/api/start.js` → `https://你的域名/api/start`
  - `/edge-functions/api/continue.js` → `https://你的域名/api/continue`
  - 两个 route 通过 `import { createHandler } from '../_shared.js'` 复用大部分骨架（DeepSeek 调用、JSON 解析、CORS、错误处理），各自只声明模型、温度、system prompt、请求解析和 finalize 校验。
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

两个 route 都是普通的 JSON 请求-响应，没有流式/SSE。

### `POST /api/start`

请求体（字段都可选）：

```json
{ "genre": "蒸汽朋克悬疑", "seed": "一只会说话的乌鸦" }
```

成功响应：

```json
{
  "ok": true,
  "narrative": "故事开场正文（带 \n\n 分段，可能含内联标记）",
  "title": "故事标题",
  "choices": ["选项 A", "选项 B", "选项 C", "选项 D"],
  "state": { "history": [...], "summary": "...", "..." }
}
```

### `POST /api/continue`

请求体：

```json
{
  "state":  { "...": "上一次响应里的 state 原样回传" },
  "action": "我悄悄绕到柱子后面"
}
```

`action` 可以是 `choices` 里的某一项，**也可以是任何自由文本**。

成功响应：

```json
{
  "ok": true,
  "narrative": "下一段故事",
  "choices":   ["...", "..."],
  "ended":     false,
  "state":     { "...": "更新后的 state" }
}
```

当 `ended` 为 `true` 时 `choices` 为空数组，前端会显示 "F I N" 收尾。

### 错误响应（两个 route 通用）

```json
{ "ok": false, "error": "可读的中文错误描述" }
```

附带相应的 HTTP 4xx / 5xx 状态码。常见错误：未配置 `DEEPSEEK_API_KEY`（500）、请求体缺 `action`（400）、DeepSeek 返回非合法 JSON（502）。

---

## 六、前端特色功能

### 自动存档

每次完成一回合，整段状态会以 JSON 形式写进 `localStorage`，刷新页面或关闭重开浏览器都能继续。

### 分享链接

右上角"分享当前进度"会把整个 state 经过 `CompressionStream('deflate-raw')` + base64url 压缩，写进 URL 的 hash 片段（`#…`）—— 不走查询字符串是为了避免被服务器或 CDN 日志记录。分享链接的体积大致是裸 JSON 的 30–40%，正常一局玩到 8–10 回合还能装得下。

### 语义内联标记

模型可以在 `narrative` 字段中嵌入以下白名单标记，前端会渲染成带样式的 `<span>`：

| 标记 | 含义 |
| --- | --- |
| `[[em]]…[[/em]]` | 强调关键词 / 转折 |
| `[[dialog]]…[[/dialog]]` | 直接引语 / 对白 |
| `[[name]]…[[/name]]` | 人名 / 地名 / 关键物品 |
| `[[sense]]…[[/sense]]` | 突出感官细节 |
| `[[whisper]]…[[/whisper]]` | 环境低语 / 心声 |
| `[[break]]` | 段内停顿（自闭合） |

解析路径**零 `innerHTML`**：用正则 `/\[\[\/?[a-z]+\]\]/g` 切 token，命中白名单的开标签压栈生成 `<span class="tag-X">`，其它任何 token（包括 HTML、含属性的伪标签、未闭合）一律降级为 `textContent`。新生成的回合和从分享链接 / 本地存档恢复出来的历史都走同一条解析路径。

### 灯笼摇曳的等待状态

"笔尖正在润墨..." 字样有一个 3.2 秒一周期、关键帧不规则（14/29/42/57/71/85%）的 `lantern-flicker` 动画，叠加 `text-shadow` 暖色光晕，模拟烛火被气流扰动。

---

## 七、设计要点 / 可以怎么改

- **故事连贯性**：`/api/continue` 收到回合后，会把 state.history 按"开场 + 中段省略 + 最近 10 回合"做一次压缩（阈值 12 回合），既保连贯又防爆上下文。
- **隐藏纲要**：`state.summary` 是一句对玩家不可见的剧情纲要，模型在每次推进时可以更新它（通过 `summary_update` 字段），用来保持长程一致性。
- **历史里的 assistant 输出包成 JSON**：传给 DeepSeek 时，历史回合里的 narrative 会被包成 `{"narrative": "..."}` 这样的最小 JSON 字符串。否则模型看到自己以前是"散文"输出，多轮之后会忘记 schema、直接返回散文 —— state.history 在前端 / 本地存档里仍然是裸 narrative，前后端契约不变。
- **选项之外的动作**：自由输入被当成 `玩家行动：xxx` 喂给模型，prompt 明确允许 AI 让不合常理的动作以合乎物理 / 世界观的方式失败，避免破坏沉浸感。
- **温度与模型**：开场用 `deepseek-v4-pro` + `temperature=1.0`（鼓励多样开局），后续用 `deepseek-v4-flash` + `temperature=0.9`（更快、更便宜，鼓励连贯性）。想要更稳定的故事可以调低温度；想更狂野调到 `1.1+`。模型替换只需改 `start.js` / `continue.js` 顶部 `createHandler({ model, temperature, ... })` 的两个字段。`max_tokens` 设在 `_shared.js` 里，目前是 1500（DeepSeek JSON 模式有时会因为撞顶截断，留余量）。
- **JSON 模式**：调用 DeepSeek 时使用 `response_format: { type: 'json_object' }`，且 system prompt 包含字面 `JSON` 字样 + `EXAMPLE JSON OUTPUT` 多行样例 —— 这是 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode) 推荐的用法。

---

## 八、注意事项

- Edge Functions 的 CPU 时间限额、并发上限、单次执行最大时长等运行时约束以 [EdgeOne Pages 官方文档](https://edgeone.cloud.tencent.com/pages/document/) 为准。本项目里 `edgeone.json` 设置 `maxDuration: 120` 是为了给 DeepSeek 慢响应留足够空间。
- DeepSeek 的实时定价、模型可用性、折扣以 [DeepSeek 计费文档](https://api-docs.deepseek.com/quick_start/pricing) 为准。
- 当前实现没有任何服务端持久化，所有状态都在浏览器（localStorage + URL）。需要"账号 / 跨设备存档"功能可以接入 EdgeOne Pages 的 KV / D1 之类，把 `state` 持久化到边缘。
