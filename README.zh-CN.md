[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick —— 在 magpie 里用你自己的 Amazon Quick（AWS Quick）账号

把**你自己**的 Amazon Quick 桌面端登录态接成 [magpie](https://github.com/yetone/magpie) 的一个 provider（`aws-quick`），
这样经 magpie 路由的 Claude Code、Codex、Gemini CLI、OpenCode 等 Agent 都能用上 Quick 背后的模型
（以 `magpie models | grep aws-quick` 列出的为准）。

> ⚠️ 仅供个人使用自己的账号。这是驱动 Amazon Quick 桌面客户端的内部双向 WebSocket 协议
> （非公开 API），很可能违反 AWS 服务条款，账号存在被限制/封禁的风险，后果自负。

## 工作方式

magpie 有真正的插件机制：它在 Bun 里加载 **OpenCode provider 插件**。本项目就是这样一个插件：

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie 网关 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ 本插件的 fetch ──▶ wss://<qbs-cell>/streaming/quickwork-chat-bidirectional-stream
```

关键点：**不需要抓包、不需要代理、不需要改 app**。Amazon Quick 桌面端本身就内置一个
Python 后端（`quickwork-agent`，打包在 `resources/agent.zip` 里），以 `--outpost-only`
模式独立运行后会在 `127.0.0.1:<port>` 暴露 `/health`、`/auth/status`、`/auth/sncs-session`、
`/local/outpost-id` 等本地接口，并能读到桌面端保存在系统凭据存储里的登录态。

插件做的事：

1. **找到并启动 outpost**：优先用 app 已解压到 userData 的 `quickwork-agent`；找不到就把
   `resources/agent.zip` 解压到临时目录再跑。用**我们自己生成的 instance token** 通过
   stdin 交给子进程（与 Electron 主进程 `AgentBridge` 的契约一致），等 `/health` 就绪。
2. **取会话**：`GET /auth/sncs-session` 拿到 `{id_token, ws_host, actor_arn, …}`，
   `GET /local/outpost-id` 拿到设备 id；按 `usable_until` 缓存，临期自动重取。
3. **连聊天 WS**：`wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`
   （query: `surfaceType`/`token`/`outpostId`/`workingSessionId`/`channel`），
   发 `session_connect`（等 `session_established`/`connected` 应答），再发 `user_message`。
   上行是 `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}` 的
   二进制帧；下行是 AWS event-stream 帧（`:event-type=rawOutputEvent`，body 里同样是
   base64 包的 inner JSON）。每 25s 发 `ping`。
4. **协议翻译**：OpenAI 的 `messages` 渲染成 Quick 的 `text`（见下）；下行的
   `text_delta`/`thinking_delta`/`turn_usage`/`message_complete` 转成 OpenAI 的
   `content`/`reasoning_content`/`usage`。一个 user turn 以 `message_complete`
   （`continuation_expected !== true`）结束——与桌面渲染端判定一致。
5. **会话复用（默认开启）**：OpenAI 客户端每次重发完整历史，而 Quick 在服务端按
   `thread_id` 保存会话。插件哈希缓存"我们回答过的那一刻"的消息链：后续请求如果是
   前缀延伸，就沿用同一 `thread_id`、只发增量文本；历史被编辑、system prompt/工具/
   模式变了、缓存过期或用一次即作废时自动新建 thread 并发送完整 transcript。

### 模型：agent_mode，不是模型 id

Quick 的 `user_message` 用 `agent_mode` 选择档位，服务端再路由到具体模型
（`turn_usage` 里有 `resolved_model_id`/`served_model_id`）：

| magpie 模型 id | agent_mode | 实测 resolved_model_id（示例） |
|---|---|---|
| `fast` | fast | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | （随服务端路由） |
| `smart` | smart | `us.anthropic.claude-opus-5-5` |
| `advanced` | advanced | （服务端可能归一到 smart） |

`X-Magpie-Effort` 头（或 body 的 `reasoning_effort`/`thinking_effort`）映射到
`thinking_effort`：`off/low/medium/high/max`。

## 安装

### 1. 前提

- **magpie**（OpenCode 插件宿主）。
- **Amazon Quick 桌面版**：已安装并**登录**（`C:\Users\Yon\AppData\Local\Programs\quickwork\` 下，
  Windows；macOS 为 `/Applications/Amazon Quick.app`）。插件复用它的后端与登录态，
  **不需要**桌面端保持运行——登录态存在系统凭据存储里，插件自己会拉起 outpost。
- **Node ≥ 22**：只在跑测试时需要；插件本身是纯 ESM、无第三方依赖。

### 2. 安装插件

```bash
magpie plugin add <本目录或 git URL>
magpie login aws-quick        # keyless：直接探测本地 Quick 登录态
```

登录时插件会启动 outpost 并调用 `/auth/sncs-session` 验证会话可用；
未登录桌面端会明确报错提示先去登录。

## 已知限制

- **工具调用是文本约定模拟**：Quick 的 agent 在服务端自带工具链（浏览器、本地文件、MCP 等），
  `tool_start`/`tool_result` 等事件由它自己执行、客户端只观测，`message_complete.tool_calls`
  恒为空。客户端传入的 OpenAI `tools` 通过提示词注入为 `<tool_call>{json}</tool_call>`
  文本约定，由插件解析成标准 `tool_calls` 返回；`tool` 角色的结果渲染为
  `[tool_result …]` 续接同一 thread。可靠性取决于模型遵守约定——已实测
  `tool_choice:'required'` 下 smart/advanced 均能稳定产出；模型偶尔会先用
  自带工具（如联网搜索）直接作答，此时表现为普通文本回复。
  Quick 自带工具的执行结果不会映射为 OpenAI `tool_calls`（那是它内部过程）。
- **图片/附件**：`user_message` 支持 `attachments`，但插件 v1 只渲染文本，
  图片块渲染为 `[image omitted]` 占位。
- **采样参数**：`temperature` 等不在协议内，传了也会被服务端忽略（`capabilities.temperature:false`）。
- **会话与账号绑定**：thread 复用的 scope 里包含账号身份哈希；换号后旧 thread 自动失效重建。
- **多窗口/并发**：同一 QuickSocket 上不同 thread 可并行 turn；同一 thread 的并发请求会被拒绝（`busy`）。
- **消息体积**：`user_message.text` 服务端上限 64KB。超大 system prompt / 工具 schema /
  会话历史会自动压缩（schema 去注解、历史从旧到新裁、tool_result 封顶），截断时
  回复里会带 `> [quick] …已截断` 提示。

## 安全与凭据

- instance token 是插件每次启动随机生成的，**只**通过 stdin 交给子进程，不落盘、不进日志。
- `id_token`/`ws_host`/`actor_arn` 等只在内存中流转；会话缓存 key 只存哈希。
- outpost 的 `/auth/*` 全部要求 `Authorization: Bearer <instance token>`；
  `/health` 是唯一公开端点。
- 插件不会修改 Amazon Quick 的任何文件；`agent.zip` 解压到系统临时目录
  （`<tmp>/magpie-aws-quick/agent/<size>-<mtime>/`），可用 `cacheDir` 选项改位置。

## 开发

```bash
npm test          # node --test test/*.test.mjs（fake WS server，无需真账号）
node _research/smoke-plugin.mjs fast   # 真实冒烟（需要本机 Quick 已登录）
```

协议细节见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)。研究过程与抓包记录在 `_research/`（不随插件发布）。

## 许可

MIT。Amazon Quick 是 AWS 的产品，本插件与 Amazon/AWS 无隶属关系。

## 社区

有问题、建议，或想一起折腾？欢迎来 **[linux.do](https://linux.do)** 社区交流反馈。
