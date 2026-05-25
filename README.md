# 提灯人 · 文字冒险游戏（EdgeOne Pages 版）

一个部署在 **EdgeOne Pages** 上、由 **DeepSeek V4 Pro** 驱动的中文交互式文字冒险游戏。
开头由 AI 即兴生成；之后每一回合，AI 给出 3-4 个差异化的选项让你选，**也可以输入选项之外的自由动作**。

灵感来源：AI Dungeon，但保留了明确的选项作为主要交互方式。

---

## 一、项目结构

```
.
├─ index.html                       # 前端单页（暗色羊皮纸风格）
├─ edgeone.json                     # EdgeOne Pages 构建配置
├─ edge-functions/
│  └─ api/
│     ├─ start.js                   # POST /api/start    —— 生成开场
│     └─ continue.js                # POST /api/continue —— 推进故事
└─ README.md
```

- **静态资源**（`index.html`）由 EdgeOne 全球节点托管。
- **后端逻辑**完全跑在 EdgeOne Pages 的 **Edge Functions** 上，文件结构即路由：
  - `/edge-functions/api/start.js` → `https://你的域名/api/start`
  - `/edge-functions/api/continue.js` → `https://你的域名/api/continue`
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
4. 构建设置可以全部留空（这是个纯静态 + Edge Functions 项目，不需要 build 命令）。
5. 点击 **部署**。

### 方式 B：直接上传

把整个项目文件夹拖到 [pages.edgeone.ai/drop](https://pages.edgeone.ai/drop)，或者：

```bash
edgeone pages deploy . -n lantern-adventure
```

---

## 四、配置环境变量（**必须！**）

部署后，在 **EdgeOne 控制台 → 你的项目 → 设置 → 环境变量** 里添加：

| 变量名              | 值                          |
| ------------------- | --------------------------- |
| `DEEPSEEK_API_KEY`  | 你的 DeepSeek API Key（以 `sk-` 开头） |

保存后，**重新部署一次**让环境变量生效。

> Edge Function 里的访问方式是 `context.env.DEEPSEEK_API_KEY`，前端 JS **完全接触不到** 这个 Key。

---

## 五、API 说明（如果你想自己接前端）

### `POST /api/start`

请求体（都是可选的）：
```json
{ "genre": "蒸汽朋克悬疑", "seed": "一只会说话的乌鸦" }
```

响应：
```json
{
  "ok": true,
  "data": {
    "title": "...",
    "opening": "故事开场正文（带 \\n\\n 分段）",
    "choices": ["选项 A", "选项 B", "选项 C", "选项 D"],
    "state": { /* 不透明的对话状态，原样回传给 /api/continue */ }
  }
}
```

### `POST /api/continue`

请求体：
```json
{
  "state":  { /* 上次的 state */ },
  "action": "我悄悄绕到柱子后面"
}
```

`action` 可以是 `choices` 里的某一项，**也可以是任何自由文本**。

响应：
```json
{
  "ok": true,
  "data": {
    "narrative": "下一段故事",
    "choices":   ["...", "..."],
    "ended":     false,
    "state":     { /* 更新后的 state */ }
  }
}
```

当 `ended` 为 `true` 时 `choices` 为空数组，前端会显示 "F I N" 收尾。

---

## 六、设计要点 / 可以怎么改

- **故事连贯性**：每次 `/api/continue` 都会把开场 + 最近 ~10 个回合的历史塞回 prompt，旧的回合会被自动省略，避免超出上下文。
- **隐藏纲要**：`state.summary` 是一句对玩家不可见的剧情纲要，模型在每次推进时可以更新它，用来保持长程一致性。
- **选项之外的动作**：自由输入会被当成 `玩家行动：xxx` 喂给模型，prompt 明确允许 AI 让"不合理的动作"以合乎物理的方式失败，避免破坏沉浸感。
- **温度**：开场用 `temperature=1.0`（鼓励多样性），后续用 `0.9`（鼓励连贯性）。想要更稳的故事可以调低；想更狂野可以调到 `1.1+`。
- **模型替换**：把 `start.js` / `continue.js` 顶部的 `MODEL = 'deepseek-v4-pro'` 换成 `'deepseek-v4-flash'` 就能切到便宜版；DeepSeek 仍然在 OpenAI 兼容格式下工作。
- **持久化**：当前所有状态保存在浏览器内存里，刷新即丢失。如果想要"存档/读档"，可以接入 EdgeOne Pages 的 KV 存储（`context.env.your_kv_namespace`），把 `state` 持久化到边缘。

---

## 七、注意事项

- Edge Functions 单次执行的 **CPU 时间上限是 200 ms**（不含 I/O 等待），调用 DeepSeek 属于 I/O，不算 CPU 时间。
- 请求体上限 **1 MB**，对话历史正常用十几回合都到不了。
- 单文件代码包 **5 MB**，目前两个函数都只有几 KB。
- DeepSeek V4 Pro 在 2026/05/31 前有 75% 折扣，之后按定价 1/4 调整；玩多了记得看 [DeepSeek 计费文档](https://api-docs.deepseek.com/quick_start/pricing)。
