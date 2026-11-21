[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick — Use your own Amazon Quick (AWS Quick) account in magpie

Turns **your own** Amazon Quick desktop login into a [magpie](https://github.com/yetone/magpie)
provider (`aws-quick`), so agents routed through magpie — Claude Code, Codex,
Gemini CLI, OpenCode, etc. — can use the models behind Quick
(see `magpie models | grep aws-quick`).

> ⚠️ For personal use with your own account only. This drives the desktop
> client's internal bidirectional WebSocket protocol (not a public API) and
> very likely violates AWS terms of service; your account may be limited or
> banned. Use at your own risk.

## How it works

magpie has a real plugin mechanism: it loads **OpenCode provider plugins** in
Bun. This project is exactly such a plugin:

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie gateway 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ this plugin's fetch ──▶ wss://<qbs-cell>/streaming/quickwork-chat-bidirectional-stream
```

The key point: **no packet capture, no proxy, no app patching**. The Amazon
Quick desktop app already bundles a Python backend (`quickwork-agent`, packed
in `resources/agent.zip`). Run standalone with `--outpost-only`, it exposes
local endpoints — `/health`, `/auth/status`, `/auth/sncs-session`,
`/local/outpost-id` — on `127.0.0.1:<port>`, and it can read the login state
the desktop app stores in the system credential store.

What the plugin does:

1. **Finds and starts the outpost**: prefers the `quickwork-agent` the app
   already extracted into userData; otherwise extracts `resources/agent.zip`
   to a temp dir and runs it. It hands the child a **self-generated instance
   token** over stdin (the same contract as the Electron main process's
   `AgentBridge`), then waits for `/health`.
2. **Gets a session**: `GET /auth/sncs-session` returns
   `{id_token, ws_host, actor_arn, …}`; `GET /local/outpost-id` returns the
   device id. Cached until `usable_until`, refreshed automatically.
3. **Connects the chat WS**:
   `wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`
   (query: `surfaceType`/`token`/`outpostId`/`workingSessionId`/`channel`),
   sends `session_connect` (waits for `session_established`/`connected`),
   then `user_message`. Uplink frames are binary
   `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}`;
   downlink frames are AWS event-stream messages (`:event-type=rawOutputEvent`,
   body likewise base64-wrapped inner JSON). A `ping` goes out every 25s.
4. **Protocol translation**: OpenAI `messages` are rendered into Quick's
   `text` (below); downlink `text_delta`/`thinking_delta`/`turn_usage`/
   `message_complete` become OpenAI `content`/`reasoning_content`/`usage`.
   A user turn ends at `message_complete` with
   `continuation_expected !== true` — the same rule the desktop renderer uses.
5. **Thread reuse (on by default)**: OpenAI clients resend the full history
   every request, while Quick keeps conversations server-side by `thread_id`.
   The plugin hash-caches the message chain "as of our last reply": if a later
   request is a prefix extension it reuses the same `thread_id` and sends only
   the delta; when history is edited, the system prompt/tools/mode change, the
   cache expires, or a thread is single-use, it transparently starts a new
   thread with the full transcript.

### Models: agent_mode, not model ids

Quick's `user_message` selects a tier via `agent_mode`; the server routes to a
concrete model (`resolved_model_id`/`served_model_id` in `turn_usage`):

| magpie model id | agent_mode | observed resolved_model_id (example) |
|---|---|---|
| `fast` | fast | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | (server-routed) |
| `smart` | smart | `us.anthropic.claude-opus-5-5` |
| `advanced` | advanced | (may normalize to smart) |

The `X-Magpie-Effort` header (or body's `reasoning_effort`/`thinking_effort`)
maps to `thinking_effort`: `off/low/medium/high/max`.

## Install

### 1. Requirements

- **magpie** (the OpenCode plugin host).
- **Amazon Quick desktop app**: installed and **signed in**
  (`C:\Users\Yon\AppData\Local\Programs\quickwork\` on Windows;
  `/Applications/Amazon Quick.app` on macOS). The plugin reuses its backend
  and login state — **the desktop app does not need to stay running**; the
  session lives in the system credential store and the plugin spawns its own
  outpost.
- **Node ≥ 22**: only needed to run tests; the plugin itself is pure ESM with
  zero third-party dependencies.

### 2. Install the plugin

```bash
magpie plugin add <this directory or git URL>
magpie login aws-quick        # keyless: probes the local Quick session directly
```

Login starts the outpost and calls `/auth/sncs-session` to verify the session;
if the desktop app isn't signed in you'll get a clear error telling you to log
in first.

## Known limitations

- **Tool calls are a text-convention simulation**: Quick's agent owns a
  server-side toolchain (browser, local files, MCP, …); its `tool_start`/
  `tool_result` events are executed by Quick itself while clients only observe,
  and `message_complete.tool_calls` is always empty. OpenAI `tools` sent by
  the client are injected as a `<tool_call>{json}</tool_call>` text convention
  and parsed back into standard `tool_calls`; `tool`-role results render as
  `[tool_result …]` continuing the same thread. Reliability depends on the
  model honoring the convention — verified stable under
  `tool_choice:'required'` for smart/advanced; occasionally the model answers
  directly with its own tools (e.g. web search) instead, which shows up as a
  plain-text reply. Quick's built-in tool results are never mapped to OpenAI
  `tool_calls` (that's its internal process).
- **Images/attachments**: `user_message` supports `attachments`, but v1 only
  renders text; image parts become `[image omitted]` placeholders.
- **Sampling params**: `temperature` etc. don't exist in the protocol and are
  ignored server-side (`capabilities.temperature:false`).
- **Sessions are account-bound**: the thread-reuse scope includes an account
  identity hash; switching accounts transparently invalidates old threads.
- **Concurrency**: different threads can run turns in parallel on one
  QuickSocket; concurrent requests on the same thread are rejected (`busy`).
- **Message size**: `user_message.text` is hard-capped at 64 KB server-side.
  Oversized system prompts / tool schemas / history are compacted
  automatically (schema de-annotation, oldest-first history trimming, capped
  tool results); truncation is surfaced as a `> [quick] …truncated` note.

## Security & credentials

- The instance token is randomly generated per launch and passed to the child
  **only** via stdin — never written to disk or logs.
- `id_token`/`ws_host`/`actor_arn` etc. live only in memory; session-cache keys
  store hashes only.
- Every outpost `/auth/*` endpoint requires
  `Authorization: Bearer <instance token>`; `/health` is the only public one.
- The plugin never modifies any Amazon Quick files; `agent.zip` is extracted
  to a temp dir (`<tmp>/magpie-aws-quick/agent/<size>-<mtime>/`), overridable
  via the `cacheDir` option.

## Development

```bash
npm test          # node --test test/*.test.mjs (fake WS server, no real account)
node _research/smoke-plugin.mjs fast   # live smoke (needs Quick signed in locally)
```

Protocol details in [PROTOCOL.md](PROTOCOL.md). Research notes and captures
live in `_research/` (not shipped with the plugin).

## License

MIT. Amazon Quick is an AWS product; this plugin is not affiliated with
Amazon/AWS.

## Community

Questions, suggestions, or want to tinker together? Come say hi on
**[linux.do](https://linux.do)**.
