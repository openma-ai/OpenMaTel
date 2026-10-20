# OpenMaTel — Agent Observability 服务设计（Phase 1，仅设计，待评审）

- 日期：2026-10-20（Asia/Shanghai, UTC+8）。本文只是设计，没有创建 issue 或 PR，也没有改代码。
- 已定方向：后端拆成 observability / eval / training 三个独立服务，彼此只通过契约连接（trace/session id + scores；OTLP/OTel GenAI + ATIF）。console 统一一个。本期只做 **observability**。
- 硬约束：
  1. 必须是独立产品，没有 openma 也能用；
  2. 没有 Cloudflare 也能跑；
  3. 桌面个人使用不依赖 ClickHouse；
  4. 定位是 agent-native，不是 LLM-call-centric；
  5. 依赖倒置，数据管道解耦；
  6. 消息内容属于 trace 本身，和 span/step 存在一起，不另设"raw body store"。
- 前置审计：`/workspace/openma-observability-audit.md`。

---

## 1. OpenMaTel 现状

按用户要求重新做了完整核查（2026-10-20）：
- `openma-ai/OpenMaTel`：创建于 2026-05-27，只有 1 个 commit（`8518112 Initial commit`），只有 `main` 一个分支，没有 tag、PR、issue、fork，没有 homepage 和 topic，size 5 KB。仓库里只有 `README.md` 和 `LICENSE`。
- README 全文只有两行："# openMaTel / lightweight llm observability and evaluation solution on CloudFlare stack"。也就是说，原始设想是"跑在 CF 上的轻量 LLM 观测 + 评测"，没有任何更具体的设计。
- 近似命名的仓库或包：GitHub 搜索 `openmatel / openma-tel / omatel` 无结果；npm 上 `openmatel`、`@openma/telemetry`、`@openma/otel`、`@openma/observability` 都不存在（404）。
- **真正可以复用的种子**是 `@openma/common@0.11.0` 的 `./telemetry` 子路径（`openma-common/src/telemetry/*`，783 行，只依赖 `@opentelemetry/api`）：
  - `AcpTraceObserver`：读取 OpenMA session wire 消息（`session.ready / session.event / session.complete`），把 ACP `session/update` 投影成 span。
  - `SessionSpans`：`create_agent` → 每个 turn 一个 `invoke_agent` → 每个 tool 一个 `execute_tool` 子 span；用 `recordUsage` 记 context_used / size / cost。
  - `GEN_AI` 属性常量（GenAI semconv）和 `OPENMA_ATTR`（`openma.turn_id`、`openma.acp_session_id`、`openma.acp.tool_kind`、`openma.end_reason` 等）。
  - `resolveTelemetryExport`（标准 `OTEL_*` 环境变量解析）、traceparent 工具函数、`summarizeSpan`。
  - **目前没有任何调用方**：OSS、backchat、Martty、pi-bot、deepseek-harness-acp、pi-acp 里都搜不到。
- 其他相关发现：
  - dsh 自带 `@deepseek-ai/dsh-session-telemetry-otel` 插件，默认 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`，导出到 DeepSeek 的 collector。通过 `DSH_TELEMETRY_OTLP_URL` 可以改向，这可以作为 dsh 原生 OTLP 的接入口，需要先确认它发的 signal 类型（logs）和内容。
  - openma 的 Timeline 和 Trajectory v1 都是从 session event log 投影出来的，不依赖 OTel。

**结论**：OpenMaTel 等于一个空仓库加一个名字。建议把它作为这个独立服务的主仓库，并把 `@openma/common/telemetry` 里与产品无关的部分迁过去，作为 OTel GenAI 互通层（`openma-common` 保留一个兼容 re-export）。

---

## 2. 定位：Agent Observability，而不是 LLM Observability

### 2.1 和 Langfuse / LangSmith / Braintrust / Phoenix 的区别

| 维度 | LLM 观测（Langfuse 等） | OpenMaTel（agent-native） |
|---|---|---|
| 一等对象 | trace → observation（generation/span），以 LLM 调用为中心 | **session → turn → step**；LLM 调用只是 step 的一种 |
| 工具 | 一般的 span，输入输出是 JSON | **一等 ToolCall**：input、output、error、duration、retry、权限审批、所属 harness 的 tool kind |
| 环境动作 | 基本没有 | **sandbox/env action**：命令（exit code、stdout/stderr）、文件编辑（diff）、浏览器动作（URL、截图） |
| 多 agent | 嵌套 span | **subagent/handoff 就是 child session**，有自己的 turn 和 step，可以单独打开 |
| 计划与控制 | 无 | plan/todo 更新、interrupt/cancel、permission request/decision、compaction、resume |
| harness | SDK 名称 | **harness name/version、ACP agent、模型、工作目录、git 分支** |
| 数据来源 | SDK / OTLP 埋点 | OTLP + **ATIF** + **ACP 流** + **直接读本地会话文件**（Claude Code / Codex / dsh / pi …），不需要埋点 |
| UI 重心 | prompt / token 表、成本 | **行为时间线**、tool 错误热点、diff 视图、命令输出、回放、subagent 树；token/成本是辅助信息 |
| 部署 | 服务端（Langfuse v3 需要 ClickHouse + Postgres + Redis + S3） | **单进程桌面版（零服务）** → Postgres 团队版 → ClickHouse 规模版；可以运行在 CF 上，也可以完全脱离 CF |
| 和 eval/RL 的关系 | 自带 eval | 观测服务只输出 trace 和 score 契约；eval 和训练是独立服务 |

OTel GenAI 和 OpenInference 只作为**互通格式**（导入和导出），不作为内部模型。内部模型是 §4 的 canonical agent events。

---

## 3. 架构原则与包结构（依赖倒置 + 解耦的数据管道）

### 3.1 原则
1. `core` 只放领域模型（canonical agent events、实体、schema 版本）和 ports（接口）。core 不依赖任何 IO、平台或 openma。
2. 其他所有东西都是 adapter，依赖 core，**core 永远不反向依赖它们**。
3. 管道分阶段：**Source → Normalizer → Processor chain → Sink(s)**，阶段之间通过 Bus 连接。语义是 at-least-once；每个事件有确定性的 `event_id`，Sink 负责幂等 upsert。
4. 写（Sink）和读（Query）是两个独立 port：store 可以只写（Parquet 导出、OTLP 转发），也可以只读（原地查询本地文件），也可以读写都支持（SQLite / Postgres / ClickHouse）。
5. UI 只和 Query API（HTTP）通信，不直接访问 store。
6. 认证、租户、存储、迁移都由服务自己负责。openma 只是一个 integration（emitter + console 嵌入 + 可选的 auth 插件）。

### 3.2 仓库与包布局（`openma-ai/OpenMaTel`，pnpm monorepo，Apache-2.0 或 MIT）

```
packages/
  core/                 # 领域模型 + ports + schema 版本 + 纯函数（step 树构建、usage 汇总、cost 计算）
  contract-tests/       # 所有 adapter 必须通过的契约测试（vitest 套件，按 port 分组）
  sources/
    otlp/               # push：OTLP/HTTP (protobuf+json) traces（logs 可选）→ 原始 OTel span
    atif/               # push/pull：ATIF v1.x trajectory JSON
    acp/                # push：ACP session/update 流（含原 AcpTraceObserver 的语义）
    sdk-http/           # push：薄 SDK 的原生 canonical 事件批量接口
    claude-code/        # pull：~/.claude/projects/*/*.jsonl
    codex/              # pull：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    dsh/                # pull：~/.dsh/sessions/<cwd>/session-<uuid>/session.v4.jsonl.zstd
    pi/                 # pull：~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl
    oma-local/          # pull：~/.oma/（backchat / oma CLI 共享的 sessions.db / sessions/）
    openma-events/      # push：openma managed session events（span.* / agent.* / user.*）
  normalizers/          # 每个 source 一个 normalizer（可以和 source 放同一个包；按 schema 版本注册）
  processors/
    redaction/          # 密钥 / PII 脱敏（规则 + 正则 + 自定义）
    capture-level/      # off / truncated / full 内容采集级别
    enrich-cost/        # 价格表 → 成本（usage 缺失时不计算成本）
    enrich-harness/     # harness 与模型元数据补全
    score-hook/         # 把 step/session 投递给外部 eval 服务（webhook / queue），回收 score
  bus/
    inproc/             # 桌面：内存队列 + 落盘 checkpoint
    pg/                 # 团队：Postgres 表队列（SKIP LOCKED）
    cf-queues/          # CF：Cloudflare Queues
    nats/ kafka/        # 规模化：可选
  stores/
    sqlite/             # Sink + Query（桌面默认，node:sqlite，零原生依赖）
    duckdb/             # Query（可选加速 / 分析；也可直接读 Parquet/JSONL）+ 可选 Sink
    postgres/           # Sink + Query（团队自托管默认）
    clickhouse/         # Sink + Query（规模 / 托管）
    d1/                 # Sink + Query（CF 小规模；可选）
  sinks/
    otlp-forward/       # 只写：把 canonical 事件投影回 OTel GenAI 并转发给其他后端
    parquet/            # 只写：按日期和项目分区导出（本地目录 / S3 兼容 / R2）
    atif-export/        # 只写：导出 ATIF
  blob/                 # 可选附件存储端口与适配器：local-fs / s3 / r2（只存图片、文件、批量导出）
  auth/                 # 服务自有 auth（project API key、org、成员）+ 插件接口
  auth-openma/          # 可选插件：openma workspace key / accounts.openma.ai OIDC 映射
  server/               # Hono app：ingest + query + auth；平台无关
  runtime-node/         # Node 入口（单进程或 server 模式；Docker 镜像）
  runtime-cloudflare/   # Workers 入口（fetch + queue consumer + cron）
  ui/                   # React 组件库 @openmatel/ui（trace 列表 / 详情 / 时间线 / diff / 热点）
  app/                  # 独立 Web UI（Vite SPA，包装 @openmatel/ui，由 server 静态托管）
  cli/                  # `npx openmatel`：启动本地 server + UI，扫描本地会话
  sdk-js/ sdk-py/       # 薄 SDK：canonical 事件或 OTel GenAI 的帮助函数
examples/
  docker-compose.team.yml   # Postgres（+ 可选 MinIO）
  docker-compose.scale.yml  # Postgres + ClickHouse（+ 可选 MinIO）
  non-openma-agent/         # 用 OTel GenAI SDK 发送 trace 的示例（如 OpenAI Agents SDK / LangGraph）
```

### 3.3 依赖方向

```mermaid
flowchart BT
  core[core<br/>domain model + ports]
  ct[contract-tests] --> core
  subgraph adapters
    src[sources/*] --> core
    nrm[normalizers] --> core
    prc[processors/*] --> core
    bus[bus/*] --> core
    st[stores/*] --> core
    sk[sinks/*] --> core
    bl[blob/*] --> core
    au[auth, auth-openma] --> core
  end
  st --> ct
  sk --> ct
  src --> ct
  bus --> ct
  srv[server<br/>Hono: ingest/query/auth] --> core
  srv -. composes via DI .-> adapters
  rn[runtime-node] --> srv
  rc[runtime-cloudflare] --> srv
  cli[cli npx openmatel] --> rn
  ui[ui @openmatel/ui] -->|HTTP Query API only| srv
  app[app standalone SPA] --> ui
  oma[openma console] --> ui
  bc[backchat / Martty desktop] --> ui
  bc --> cli
```

组装（composition root）只出现在 `runtime-node`、`runtime-cloudflare`、`cli` 三处，由配置决定使用哪些 adapter。

### 3.4 Ports（TypeScript 草图）

```ts
// core/ports.ts
export interface Source {               // pull 或 push
  id: string; kind: "pull" | "push";
  start(emit: (raw: RawRecord) => Promise<void>, signal: AbortSignal): Promise<void>;
  checkpoint?(): Promise<SourceCursor>; // pull 源：文件 offset / mtime / hash
}
export interface Normalizer {
  accepts(raw: RawRecord): boolean;
  schema: { source: string; version: string };
  normalize(raw: RawRecord): AgentEvent[];  // 纯函数，确定性 event_id
}
export interface Processor { id: string; process(e: AgentEvent, ctx: ProjectCtx): Promise<AgentEvent | null>; }
export interface Bus { publish(batch: AgentEvent[]): Promise<void>; subscribe(h: (b: AgentEvent[]) => Promise<void>): Unsubscribe; }
export interface Sink { id: string; write(batch: AgentEvent[]): Promise<void>; /* 必须按 event_id 幂等 */ }
export interface Query {
  listSessions(q: SessionQuery): Promise<Page<SessionSummary>>;
  getSession(id: SessionRef): Promise<SessionDetail | null>;         // 含 turn/step 树和子 session 引用
  listSteps(q: StepQuery): Promise<Page<Step>>;                       // 筛选：类型 / 错误 / 工具名 / harness
  aggregate(q: AggQuery): Promise<AggResult>;                         // 错误热点、usage、成本、耗时分布
  getContent?(ref: ContentRef): Promise<Content | null>;              // 大内容按需取（同一个 store）
}
export interface BlobStore { put(key: string, body: Bytes, meta?: BlobMeta): Promise<void>; get(key: string): Promise<Bytes | null>; }
export interface AuthProvider { authenticate(req: Request): Promise<Principal | null>; }  // 插件化
```

### 3.5 契约测试（`packages/contract-tests`，所有 adapter 在 CI 中都要跑）
- **Normalizer**：golden fixtures（每种来源的真实样本，脱敏后放进仓库）→ 期望的 canonical 事件快照；同一输入重复 normalize 得到相同 `event_id`；未知行类型不能抛异常，要保留为 `raw.unknown`。
- **Sink**：同一批事件写两次结果相同（幂等）；乱序到达（child 比 parent 早）最终一致；`usage` 为 null 时保持 null，不能变成 0。
- **Query**：在每个读写 store 上用同一组 fixture 断言相同结果，包括 session 树、step 过滤、错误热点、usage 覆盖率、分页稳定性；capture-level 为 off 时不返回内容。
- **Bus**：at-least-once（consumer 抛错后重投）；批次顺序不保证，处理逻辑不能依赖顺序。
- **Source（pull）**：文件追加时增量读取；文件被截断或轮转后从头再读；checkpoint 恢复后不重复也不遗漏（由幂等兜底）。
- **Auth**：project key 的作用域隔离（A 项目的 key 读不到 B）；插件可以链式组合。
- CI 矩阵：`stores/sqlite`、`stores/duckdb`（只读查询）、`stores/postgres`（service container）、`stores/clickhouse`（service container）、`stores/d1`（Miniflare/workerd）全部跑同一套 Query/Sink 契约；`runtime-cloudflare` 用 Miniflare 跑 e2e，`runtime-node` 用 Docker 跑 e2e。

---

## 4. Canonical agent event schema（`oma.agentobs.v1` 草图）

### 4.1 实体
- **Project**（租户单位，属于 Org）→ **Session**（一次 agent 会话；subagent 是 child session，带 `parent_session_id` 和 `parent_step_id`）→ **Turn**（一次用户输入到 agent 停止）→ **Step**（turn 里的原子行为，可以嵌套，用 `parent_step_id` 表示）。
- **Score**：挂在 session、turn 或 step 上。字段：`name`、`value`、`source = eval | online | human | harness`、`grader_id`、`grader_version`、`comment`。Score 是一等实体，eval 服务通过它回写。
- **Attachment**：大二进制（图片、文件）的引用，指向 BlobStore。没有配置 BlobStore 时只保留元数据和缩略图（或直接丢弃，由策略决定）。

### 4.2 事件信封（所有 source 归一化后都是这个形状）

```ts
interface AgentEvent {
  schema: "oma.agentobs.v1";
  event_id: string;          // 确定性：hash(source, source_session_id, source_seq | natural key)
  project_id: string;
  session_id: string;        // canonical；跨 source 时 = hash(source, source_session_id)
  turn_id?: string; step_id?: string; parent_step_id?: string;
  ts: string; end_ts?: string;              // ISO；step 的开始和结束
  kind: EventKind;                          // 见下
  status?: "ok" | "error" | "cancelled" | "interrupted" | "denied" | "timeout";
  error?: { type: string; message: string; retryable?: boolean };
  attrs: Record<string, unknown>;           // 各 kind 的结构化字段（下表）
  content?: { input?: Content; output?: Content; capture: "full" | "truncated" | "redacted" | "none" };
  usage?: Usage | null;                     // 只出现在 llm.call / turn 汇总
  source: { name: string; version?: string; format: string; ref?: string };  // 溯源：文件路径+offset、OTLP span id 等
  links?: { trace_id?: string; span_id?: string; external?: Record<string, string> }; // OTel / openma session id 等
}
interface Usage {               // null = 未知；0 = 确实为 0
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null; reasoning_tokens: number | null;
  source: "provider" | "harness" | "estimated" | "missing";
  cost_usd?: number | null; cost_source?: "price_table" | "provider" | "harness";
}
```

### 4.3 EventKind 与结构化 attrs

| kind | 关键 attrs | 来源示例 |
|---|---|---|
| `session.start` / `session.end` | harness{name,version,acp_agent?}, model, cwd, git{branch,commit}, user, title, end_reason | 所有来源 |
| `turn.start` / `turn.end` | trigger(user/schedule/handoff), stop_reason, 汇总 usage | ACP prompt/response、Claude user/assistant |
| `message.user` / `message.agent` / `reasoning` | role、文本（content）、附件引用 | 所有来源 |
| `llm.call` | provider, model, request_id, ttft_ms, finish_reason, usage | openma `span.model_request_*`、Codex token_count、OTel `chat` span |
| `tool.call` | tool_name, tool_kind(read/edit/execute/fetch/search/mcp/other), call_id, input, output, duration_ms, retry_of? | ACP tool_call/tool_call_update、Claude tool_use/tool_result、OTel `execute_tool` |
| `env.command` | command, cwd, exit_code, stdout/stderr（content）, duration | bash/terminal 工具、Codex exec、openma sandbox exec |
| `env.file_edit` | path, op(create/modify/delete), diff（unified）, bytes | ACP diff content、Claude Edit/Write、Codex apply_patch |
| `env.browser` | action(navigate/click/type/screenshot), url, selector, screenshot 附件 | openma browser、Computer-use |
| `subagent.spawn` / `handoff` | child_session_id, agent_name, task | openma threads、Claude sidechain(isSidechain)、ACP subagents |
| `plan.update` | entries[{content,status,priority}] | ACP `plan`、Claude TodoWrite |
| `permission.request` / `permission.decision` | tool, options, decision(allow_once/always/deny), decided_by | ACP request_permission、Claude permissionMode |
| `control.interrupt` / `control.cancel` / `control.retry` / `control.compaction` / `control.resume` | reason, summary_tokens | openma user.interrupt/compaction、dsh compaction |
| `memory.read/write`、`skill.use` | store/skill id, version, key | openma memory/skills、Hermes skills |
| `outcome` | rubric_id, verdict, iterations | openma `span.outcome_evaluation_*` |
| `raw.unknown` | 原始行（受 capture level 约束） | 任何无法识别的记录 |

### 4.4 与外部格式的映射
- **OTel GenAI**（导入和导出双向）：
  - `invoke_agent` span ↔ turn（`gen_ai.conversation.id` = session_id）；
  - `execute_tool` ↔ `tool.call`（`gen_ai.tool.name` / `gen_ai.tool.call.id`）；
  - `chat` / `text_completion` ↔ `llm.call`（`gen_ai.usage.*`、`gen_ai.request.model`、`gen_ai.response.finish_reasons`）；
  - `gen_ai.input.messages` / `gen_ai.output.messages`（或 GenAI events）↔ content；
  - `create_agent` ↔ `session.start`；
  - 没有标准属性可用的 agent 语义用 `openma.*` 命名空间（沿用 `OPENMA_ATTR`），例如 `openma.step.kind`、`openma.env.exit_code`、`openma.file.diff`。
  - 导入时 span 树 → step 树；导出时反向（由 `sinks/otlp-forward` 负责）。
- **ATIF v1.x**（Harbor）：`Trajectory` ↔ session；`Step`（source = user/agent/system）↔ message/turn；`tool_calls` + `observation` ↔ `tool.call`；`metrics`（tokens、cost、token ids、logprobs）↔ `usage` 和 `attrs.rl`；`subagent_trajectories` ↔ child session。往返转换要有 golden 测试。
- **ACP**：`session/update` 的 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update`（含 diff、terminal 内容）/ `plan` / `usage_update`，加上 `request_permission`、`PromptResponse.stopReason/usage` → 对应的 kinds。
- **openma managed events**：`user.message`、`agent.message`、`agent.thinking`、`agent.tool_use/result`、`agent.mcp_tool_*`、`span.model_request_*`、`span.outcome_evaluation_*`、`span.compaction_*`、`session.status_*`、`session.thread_*` → 对应的 kinds（由 `sources/openma-events` 映射，替代现有的 Timeline `derive.ts` 逻辑）。

### 4.5 Usage："缺失"和"0"必须分开
- schema 层：token 字段是 `number | null`，并带 `usage.source`。ClickHouse 用 `Nullable(UInt64)`；SQLite/Postgres 用可空列。
- normalizer 规则：来源没给 usage 时写 `null` 加 `source: "missing"`，**禁止写 0**。这一条修掉了 `openma-common` 里 `managed-event-projector.ts` 的 `nonNegative(undefined)=0` 问题；openma 侧也要同步修复（见 OBS-17）。
- 可选的估算 processor：用 tokenizer 估算出的 token 写 `source: "estimated"`，UI 用虚线或 "≈" 标出。
- 汇总：返回 `{sum, coverage: 有 usage 的 llm.call 数 / 总数}`，UI 显示 "18.1k tokens（覆盖 67%）"。成本只对有 usage 的调用计算。

---

## 5. Sources：本地文件（只读 connector）+ push

### 5.1 本机实测路径和格式（box 上实际存在；macOS 路径相同，都在 `$HOME` 下）

| 来源 | 路径 | 格式要点 | 实测样本 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` | JSONL；`type ∈ user/assistant/attachment/queue-operation/api-request*/cost-state/last-prompt…`；`parentUuid` 构成链；`isSidechain` 表示 subagent；`message.content[]` 里有 tool_use/tool_result；有 `modelUsage`、`gitBranch`、`cwd` | 45 个文件 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `session_meta`、`turn_context`、`response_item`（message / function_call / function_call_output…）、`event_msg`（task_started / task_complete / token_count / item_completed）、`token_usage_record` | 20 个文件 |
| dsh（DeepSeek Harness） | `~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd`（加 `session.lock`） | zstd 压缩的 JSONL（v4）；首行是 session header（id、createdAt、cwd、delegationDepth…）；可能是多个追加的 zstd frame，读取器要逐 frame 解码 | 65 个目录 |
| pi | `~/.pi/agent/sessions/<cwd-slug>/<iso-ts>_<uuid>.jsonl` | `session`、`model_change`、`thinking_level_change`、`message`（role = system/user/assistant/toolResult） | 2 个文件 |
| backchat / oma CLI | `~/.oma/`（`sessions.db`（node:sqlite）、`sessions/`、`acp/`） | backchat 的 file-first 会话（`src/main/file-first-export.ts`）；ACP 事件 | 本机未生成；格式从 backchat 源码确认 |
| Martty | 通过 ACP 运行，会话持久化见 `Martty/docs/sessions*.md`（`/resume`） | 待确认具体目录，可能复用 dsh / `~/.oma` | 待确认 |
| openma 托管 | 不读文件；push（`sources/openma-events`）或 OTLP | managed session events | – |

**Pull 源的行为**：
- 只读，**不复制原始文件**。索引写入本地 store（SQLite）。`source.ref` 记录文件路径和字节 offset，所以大内容可以回源读取（`Query.getContent` 由 `sources/*` 的 reader 提供），这也是 Query 端口支持只读 store 的用法。
- 用 `fs.watch` 加周期 rescan；checkpoint = (inode, size, mtime, 最后 offset, 尾部 hash)。
- 发现机制：`openmatel sources detect` 列出本机检测到的来源和会话数量，用户逐个启用。默认只启用 Claude Code、Codex、dsh、pi。
- 隐私：本地模式数据不出本机；内容默认按 `full` 索引，可以改成 `truncated` 或 `off`。

### 5.2 Push 源
- `POST /v1/otlp/v1/traces`（OTLP/HTTP protobuf + JSON；gzip）。OTLP logs 可选（dsh 的 telemetry 插件发的是 logs）。
- `POST /v1/ingest/atif`（单个或批量 ATIF JSON；也可以 multipart 上传 Harbor 的 `trajectory.json`）。
- `POST /v1/ingest/events`（canonical 事件批量，SDK 使用）。
- `POST /v1/ingest/acp`（ACP session/update 流的 NDJSON；给 ACP 客户端 / host 用，比如 backchat、Martty、openma acp-runtime）。

---

## 6. 存储分层与部署形态（全部在 adapter 后面）

### 6.1 三个层级
| 层级 | 场景 | Bus | Sink / Query store | 附件 | 进程 |
|---|---|---|---|---|---|
| **Desktop**（默认） | 个人、本机 | `bus/inproc` | `stores/sqlite`（node:sqlite，WAL，FTS5）+ 本地文件原地读取 | 本地目录（可选） | 单进程（`npx openmatel` 或嵌入 Electron） |
| **Team**（自托管） | 小团队、内网、k8s | `bus/pg` | `stores/postgres`（控制面 + 数据） | S3 兼容（可选；MinIO / 本地目录） | Node 容器 ×N（无状态）+ Postgres |
| **Scale / Hosted** | 托管 SaaS、大规模 | `bus/cf-queues` 或 `nats/kafka` | `stores/clickhouse`（数据）+ Postgres 或 D1（控制面） | S3 / R2（可选） | CF Workers 或 Node 容器 + ClickHouse |

### 6.2 SQLite 还是 DuckDB（桌面默认）
| | SQLite（`node:sqlite`） | DuckDB（`@duckdb/node-api`） |
|---|---|---|
| 依赖 | **Node 22.5+ 内置，零原生依赖**；backchat 已经在用 | 原生二进制（体积大，Electron 需要按平台分别打包） |
| 写入 | 稳定，WAL 下支持多读单写、增量 upsert | 单写进程锁，频繁小批量 upsert 较弱 |
| 分析 | 中等规模（几十万 step）够用；有 FTS5 全文检索 | 列存，聚合快；**可以直接读 JSONL/Parquet**，非常适合"原地查询"和导出分析 |
| 结论 | **桌面默认 Sink + Query** | **可选**：`stores/duckdb` 作为只读分析 Query（读 SQLite 或 Parquet 导出）和 `sinks/parquet` 的伙伴；日后数据量大时再切换 |

### 6.3 内容存储（消息内容是 trace 的一部分）
- 内容（prompt、response、tool input/output、命令输出、diff）**和 step 存在同一张表、同一行**：ClickHouse 用 `String CODEC(ZSTD(3))` 存 input/output 列（同 Langfuse v3 的做法）；Postgres 用 `TEXT` / `JSONB`（TOAST 压缩）；SQLite 用 `TEXT`（可选 zstd 应用层压缩）。
- 每个项目设 **capture level**：`off`（只保留结构和元数据）/ `truncated`（每个字段默认 8 KB，可配置）/ `full`。由 `processors/capture-level` 在写入前执行。截断时记录 `content.capture="truncated"` 和原始长度。
- **Redaction**（`processors/redaction`）在 capture-level 之前执行：内置密钥规则（API key、Bearer、AWS、私钥、`.env` 形态）、可配置的正则和 PII 规则，作用于内容和 attrs；参考 pi-bot `redactTraceValue()` 的语义（剥离 thinking/reasoning 可选）。
- **TTL**：项目级 `content_ttl_days`（内容过期后置空，保留结构）和 `data_ttl_days`（整行删除）。ClickHouse 用列级 TTL 和行级 TTL；Postgres/SQLite 用定时清理任务。
- **对象存储只用于**：大二进制附件（图片、截图、上传文件）和可选的批量导出（Parquet / ATIF）。**任何层级都不强制要求对象存储**；没有配置时，附件只保留元数据，可选保留缩略图（大小上限内的小图直接内联存储）。

### 6.4 平台适配：Cloudflare 与非 Cloudflare
沿用 openma 已有的模式：
- 端口 / 适配器结构参照 `packages/blob-store`（`cf-r2` / `s3` / `local-fs` / `in-memory`）和 `packages/queue`（`cf` / `pg` / `in-memory`）；
- `platform-cloudflare` / `platform-node` 双入口；
- `apps/main-node/Dockerfile`，由 `.github/workflows/build-server-image.yml`（"Build OpenMA Server Image"）发布到 `ghcr.io/<repo>`（目前只有 linux/amd64）；
- CI 已经在跑 mysql 和 postgres 的集成测试。

| 组件 | Cloudflare adapter | 非 CF（Node / Docker / k8s） |
|---|---|---|
| HTTP（ingest / query / UI 静态资源） | Workers（`runtime-cloudflare`，Hono） | Node（`runtime-node`，Hono + @hono/node-server） |
| Bus | Cloudflare Queues（consumer Worker 批量写） | 进程内（desktop）/ Postgres 表队列（team）/ NATS（可选） |
| 控制面（org、project、keys、设置、价格表） | D1 | Postgres（team / scale）/ SQLite（desktop） |
| Trace 数据 | 小规模：D1（单库 10 GB 上限，适合试用）；**推荐：ClickHouse Cloud**（Worker 通过 HTTPS 访问，或用 Hyperdrive 之类的代理） | SQLite / Postgres / ClickHouse（自托管） |
| 附件 / 导出 | R2（可选） | 本地目录 / S3 兼容（MinIO 等，可选） |
| 定时任务（TTL、聚合、rescan） | Cron Triggers | node-cron / k8s CronJob |
| Pull 源（本地文件） | **不支持**（Workers 没有文件系统） | 支持（desktop / 本机 server） |
| OTLP protobuf 解码 | 支持（纯 JS 解码，需控制包体积） | 支持 |
| 原生 OTel SDK 自埋点 | 用轻量手写 exporter（workerd 上 OTel SDK 不成熟） | 用标准 OTel SDK |

**推荐默认**：
- desktop：SQLite，无 bus 服务，无对象存储；
- team：Postgres 单库加 Node 容器；
- hosted（app.openma.ai 侧）：CF Workers 负责 ingest/query/UI，Queues 做 bus，**ClickHouse Cloud** 存 trace 数据，D1 做控制面，R2 可选。
  - 理由：沿用现有 CF 运维体系；D1 不适合大规模 trace 分析。
  - ClickHouse 不能运行在 CF 上，所以 hosted 是 CF + ClickHouse Cloud 的组合。
  - 如果希望 hosted 也完全不依赖 CF，可以直接复用 team/scale 的 Node 镜像部署到任意 k8s。

### 6.5 成本量级（仅供参考，公开价格可能变化，上线前需要复核）
- Desktop：$0。
- Team 自托管：一台 2 vCPU / 4 GB 的 VM 跑 Postgres 加 Node，大约 $20–40/月（云主机价格）；百万级 step/月 没有压力。
- Hosted：
  - Workers Paid $5/月起，加请求费（约 $0.30/百万请求）；
  - Queues 按操作计费（约 $0.40/百万次）；
  - D1 控制面接近免费；
  - ClickHouse Cloud 是主要成本，最低档大约几十到数百美元/月，取决于存储和计算（**未复核**，需要确认当前价格）；
  - R2 按存储加操作计费，出口流量免费。
- 对比参考：Langfuse v3 自托管至少需要 ClickHouse + Postgres + Redis + S3 四个组件；我们的 team 档只要 Postgres。

---

## 7. 认证、租户、与 openma 的集成边界

- **自有模型**：Org → Project → 成员（email 登录 / magic link / OIDC 插件）。Project API key 分两种：`otk_…` 只能 ingest，`osk_…` 可以 query 和管理；key 只存哈希，可以轮换和撤销。Desktop 模式默认单用户，免登录，只监听 127.0.0.1，并带随机 token。
- **插件 `auth-openma`（可选）**：
  - 接受 openma workspace API key 或 accounts.openma.ai（Better Auth OIDC）登录；
  - 按配置把 openma workspace 映射到 Project（`workspace_id → project_id`，首次访问时自动创建）。
  - 服务本身不 import 任何 openma 代码，只走 OIDC 标准流程，以及（可选）调用 openma `/v1/oma/me` 校验 workspace key。
- **openma 只是一个 integration**：
  1. **emitter**：openma 托管侧在 session event 落库之后，由一个独立的投递 consumer 把事件 push 到 OpenMaTel 的 `/v1/ingest/events`（由 `sources/openma-events` normalizer 映射）；ACP harness 侧（acp-runtime / backchat / Martty）接上 `AcpTraceObserver` 或直接推 ACP NDJSON。
  2. **console 嵌入**：openma console 引入 `@openmatel/ui`。
  3. **auth 插件**：见上。

### API 位置（审计时遗留的待决问题）的建议
- **观测 API 属于 OpenMaTel 服务自己**：`https://obs.<domain>/v1/{otlp,ingest,query}/…`，独立域名或子域。**不放进 openma 的 `/v1/*`**，保持 managed `/v1/*` 和 Anthropic 完全兼容；也**不在 openma 里实现观测路由**。
- openma 侧只在 `/v1/oma/observability/*` 提供很薄的 token exchange 和 proxy（可选）：openma 用户的 cookie / workspace 换取短期 OpenMaTel query token，console 再直连 OpenMaTel（CORS）。
- 所以对"`/v1/oma/*` vs `/v1/*` include"这个问题的建议是：**选 `/v1/oma/*`，而且只放 token exchange 或 proxy**。旧的 `/v1/oma/sessions/:id/trajectory` 保留给 eval/RL 服务使用，以后迁到 ATIF 导出。

---

## 8. Query API（UI 只通过它访问数据）

```
GET  /v1/query/sessions?project=&q=&harness=&model=&status=&has_error=&tool=&from=&to=&cursor=
GET  /v1/query/sessions/:id                       # session + turns + step 树（分页 / 惰性加载子节点）+ child sessions + scores
GET  /v1/query/sessions/:id/steps?kind=&status=&cursor=
GET  /v1/query/steps/:id/content                  # 大内容按需取（同一个 store；本地模式回源读文件）
GET  /v1/query/sessions/by-external?key=openma.session_id&value=sesn_…   # session ↔ 外部 id 链接
GET  /v1/query/aggregate/tool-errors?group_by=tool_name|harness|model&from=&to=   # 错误热点
GET  /v1/query/aggregate/usage?group_by=model|harness|project&from=&to=           # 带 coverage
GET  /v1/query/aggregate/latency?kind=tool.call|llm.call|turn
POST /v1/scores            # eval / 人工 / 在线打分回写（score 契约）
GET  /v1/query/sessions/:id/export?format=atif|otlp|jsonl
GET  /v1/sources           # desktop：检测到的本地来源和启用状态
```
采用游标分页；所有接口按 project 隔离；规范一份 OpenAPI 文档，SDK 由它生成。

---

## 9. UI：`@openmatel/ui` + 独立 SPA + 嵌入方式

### 9.1 嵌入方式的选择
| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **共享 React 组件包**（`@openmatel/ui`，peer：react / react-dom / @tanstack/react-query） | 和 openma console 同一个 React 树，主题、路由、命令面板都能融合；backchat（Electron + React）也能直接用 | 需要约定 peer 版本和设计 token | **推荐** |
| iframe | 完全隔离，零耦合 | 主题、深链、鼠标键盘交互、高度自适应都很别扭；鉴权要另做 | 作为 fallback（第三方嵌入） |
| Module Federation | 运行时独立发布 | 构建复杂，和 Vite 生态配合一般，版本漂移难调试 | 不采用 |

做法：`@openmatel/ui` 导出 `<ObsProvider client={…} theme={…} navigate={…}>` 以及页面级组件 `<SessionList/>`、`<SessionDetail/>`、`<StepTimeline/>`、`<ToolErrorHotspots/>`、`<UsagePanel/>`。数据访问只经过注入的 `client`（基于 Query API 的 fetch 封装），**组件不知道数据存在哪个 store**。独立 SPA（`packages/app`）只是外壳：登录、项目切换、路由。openma console 用同一批组件，路由挂在 `/observe/*`。backchat 和 Martty 的桌面端可以嵌入 SPA，或者内嵌 server（`cli` 的 library 模式）再渲染组件。

### 9.2 页面（agent-native）
1. **Sessions**：过滤维度包括 harness、模型、来源（Claude/Codex/dsh/openma…）、状态、有无错误、工具名、项目、时间；列：标题 / 首条输入、harness、turn 数、step 数、tool 错误数、时长、usage（带覆盖率标记）、成本、score 徽标。
2. **Session detail**：
   - 左侧：**Step Timeline**（按 turn 分组；step 类型图标；tool 错误标红；重试折叠显示；permission 和 interrupt 用标记；subagent 是可展开的子树，也可以跳转到 child session）。
   - 右侧检查器，按 step 类型切换：tool（input/output JSON、错误、耗时）、`env.command`（终端样式输出、exit code）、`env.file_edit`（**diff 视图**）、`env.browser`（截图）、`llm.call`（消息内容、模型、TTFT、usage 及来源，"usage unavailable"标记）、`plan.update`（todo 变化）。
   - 顶部：session 元数据（harness/version、cwd、git）、汇总、scores、外部链接（openma session、Harbor job 等）。
   - **Replay**：按时间轴逐步回放（文件 diff 累积视图）。
3. **Tool error hotspots**：按工具、harness、模型统计错误率和趋势，可以点进具体 step。
4. **Usage & cost**（辅助）：按模型、harness、项目统计，显示覆盖率。
5. **Sources**（desktop）：本地来源检测、启用、索引进度。
6. **Settings**：项目、keys、capture level、redaction 规则、TTL、价格表、导出。

---

## 10. 各方怎么接入（emitters）

| 来源 | 接入方式 | 改动位置 |
|---|---|---|
| 任意非 openma agent | 标准 OTel GenAI SDK → OTLP；或 `@openmatel/sdk` | 无需改 openma（验收 demo） |
| Claude Code / Codex / pi / dsh（本机） | 本地文件 pull connector，**零改动** | – |
| dsh（远端 / 托管） | 把 `DSH_TELEMETRY_OTLP_URL` 指向 OpenMaTel 的 OTLP logs/traces，并加 normalizer | 先确认 dsh 插件发出的 signal 和内容 |
| deepseek-harness-acp / pi-acp | 作为 ACP agent，由 host（backchat / Martty / openma acp-runtime）观察；如果自己要发，接 `AcpTraceObserver` + OTLP exporter | harness 侧需保证 `PromptResponse.usage` 回传 |
| backchat / Martty | host 侧接 `AcpTraceObserver`（或直接 POST ACP NDJSON 到本地 OpenMaTel）；桌面端内嵌 `openmatel` library 模式和 UI | `src/main/brokers.ts` 一带（ACP broker） |
| openma 托管 runtime | `sources/openma-events`：session event 落库后，由独立的 Queue consumer 投递（at-least-once，event_id = session_id + seq）；ACP 路径额外接 `AcpTraceObserver` | 新增 `packages/obs-emitter`（openma 仓库），不改核心路径 |
| pi-bot | 它的 SQLite EventLog → 写一个 normalizer，或改为 OTLP 发送 | 可选 |

---

## 11. 迁移：现有 Timeline 与 Trajectory
1. **阶段 A（并行）**：openma console 的 session 页新增一个 "Trace" tab，内容是 `<SessionDetail>`（数据来自 OpenMaTel，按 `openma.session_id` 外链查找）；原 Timeline 保留。
2. **阶段 B（对齐）**：确认 `sources/openma-events` 能覆盖 `derive.ts` 的全部语义（TTFT、tool 配对、子 thread、错误），在同一组 fixtures 上做快照对比。同时修掉审计里列出的问题：tool 错误标红、显示 LLM 内容、usage 缺失提示。
3. **阶段 C（切换）**：默认展示 Trace tab，原 Timeline 降级为 "Raw events" 视图。openma 内部的 `apps/console/src/components/timeline` 冻结。
4. **Trajectory v1**：不再作为观测数据源。留给 eval/RL 服务，通过 OpenMaTel 的 `export?format=atif` 获取，或者继续使用 `/v1/oma/sessions/:id/trajectory`。旧的 trajectory modal 可以删掉，或者改成"导出 ATIF"按钮。

---

## 12. 不用 Cloudflare 运行（Running without Cloudflare）

### 12.1 Desktop：无需 compose、无需任何服务
```bash
npx openmatel            # 启动 127.0.0.1:4319（UI + Query + OTLP），自动检测 ~/.claude ~/.codex ~/.dsh ~/.pi
npx openmatel --no-open --sources claude-code,codex --data ~/.openmatel
```
数据存放在 `~/.openmatel/openmatel.db`（SQLite）。本机的 agent 也可以把 OTLP 发到 `http://127.0.0.1:4319/v1/otlp`。

### 12.2 Team：Docker Compose（Postgres，对象存储可选）
```yaml
# examples/docker-compose.team.yml
services:
  openmatel:
    image: ghcr.io/openma-ai/openmatel:latest
    ports: ["4319:4319"]
    environment:
      OPENMATEL_MODE: server
      OPENMATEL_DATABASE_URL: postgres://otel:otel@postgres:5432/openmatel
      OPENMATEL_BUS: pg
      OPENMATEL_SECRET: ${OPENMATEL_SECRET:?set}
      # 可选：附件和导出
      # OPENMATEL_BLOB_URL: s3://bucket?endpoint=http://minio:9000&region=us-east-1
      # 可选：openma 集成
      # OPENMATEL_AUTH_PLUGINS: openma
      # OPENMA_OIDC_ISSUER: https://accounts.openma.ai
    depends_on: [postgres]
  postgres:
    image: postgres:17
    environment: { POSTGRES_USER: otel, POSTGRES_PASSWORD: otel, POSTGRES_DB: openmatel }
    volumes: ["pg:/var/lib/postgresql/data"]
volumes: { pg: {} }
```
Scale 档（`docker-compose.scale.yml`）在此基础上加 `clickhouse/clickhouse-server`，设置 `OPENMATEL_TRACE_STORE=clickhouse://…`。k8s 部署提供 Helm chart：无状态 Deployment 加外部 Postgres 和 ClickHouse。镜像通过 GitHub Actions 发布到 GHCR，构建 linux/amd64 和 arm64（openma 现在只构建 amd64，这里补上 arm64，方便 Mac / ARM 服务器）。

### 12.3 CF 与非 CF 的功能差异
| 功能 | Desktop | Team（Node + PG） | Scale（Node/CF + CH） | 原因 |
|---|---|---|---|---|
| 本地文件 pull 源 | ✅ | ✅（挂载目录时） | ❌（CF）/ ✅（Node） | Workers 没有文件系统 |
| OTLP / ATIF / ACP / SDK ingest | ✅ | ✅ | ✅ | – |
| 大规模聚合（亿级 step） | ❌ | 🟡（百万到千万级） | ✅ | 存储引擎能力差异 |
| 全文搜索 | ✅ FTS5 | ✅ pg_trgm / tsvector | ✅ CH token/ngram 索引 | – |
| 多用户、SSO | ❌（单用户） | ✅ | ✅ | – |
| 附件 | 本地目录（可选） | S3（可选） | R2/S3（可选） | – |
| 自身 OTel SDK 埋点 | ✅ | ✅ | 🟡（CF 用轻量 exporter） | workerd 限制 |

---

## 13. 有序 issue 拆分（只含 observability 轨道；待用户评审后再创建）

仓库标注：**[MT]** = `openma-ai/OpenMaTel`，**[OMA]** = `open-managed-agents`，**[COM]** = `openma-common`，**[BC]** = backchat，**[MTY]** = Martty。审计中合并进来的条目标了来源（例如 ←P0-4）。

### Milestone 1：核心与桌面版（"零服务，看到本机 Claude/dsh 会话"）
1. **[MT] OBS-1 Bootstrap OpenMaTel monorepo + CI 矩阵**
   - 范围：pnpm workspace、TS 配置、lint、vitest、changesets；CI 矩阵（node 22/24 × linux/macOS），postgres 和 clickhouse 作为 service containers；Miniflare job 先占位。
   - 验收：空包能构建；CI 在 linux 和 macOS 上都通过；README 写清定位（agent observability）和非目标。
2. **[MT] OBS-2 `core`：canonical schema `oma.agentobs.v1` + ports + 纯函数**
   - 范围：§4 的类型、JSON Schema、event_id 规则、step 树构建、usage 汇总（null 语义和覆盖率）、成本计算接口；§3.4 的 ports。
   - 验收：core 没有任何 IO 依赖（依赖检查脚本强制）；schema 文档生成；单测覆盖 step 树乱序重建，以及 usage 的 null/0 区分。
3. **[MT] OBS-3 `contract-tests` 套件**
   - 范围：§3.5 的全部契约，加 fixtures 目录规范。
   - 验收：提供 in-memory 参考实现并通过全部契约；文档说明新 adapter 如何接入。
4. **[MT] OBS-4 `stores/sqlite`（Sink + Query）**
   - 范围：node:sqlite、迁移、WAL、FTS5、内容列、TTL 任务。
   - 验收：通过 Sink/Query 契约；10 万 step 时 session 列表 p95 < 200 ms（本机基准）。
5. **[MT] OBS-5 `bus/inproc` + pipeline runner**
   - 范围：Source → Normalizer → Processors → Sinks 的组装，落盘 checkpoint，错误重试和死信。
   - 验收：通过 Bus 契约；kill -9 后重启不丢、不重复（幂等）。
6. **[MT] OBS-6 本地文件 sources + normalizers：Claude Code、Codex、dsh、pi**
   - 范围：§5.1 的路径和格式；watch 加 rescan；`source.ref` 回源读取内容；脱敏后的 golden fixtures 放入仓库。
   - 验收：通过 Normalizer/Source 契约；能识别 subagent（Claude `isSidechain`）、tool 错误、文件编辑 diff、命令 exit code；dsh 的多 frame zstd 能正确解码；usage 缺失时为 null。
7. **[MT] OBS-7 processors：redaction + capture-level + enrich-cost + enrich-harness**
   - 验收：内置密钥规则用例全部被屏蔽；off / truncated / full 三档行为符合 §6.3；没有 usage 时不产生成本；价格表可配置。
8. **[MT] OBS-8 `server`（Hono）+ Query API v1 + OpenAPI**
   - 范围：§8 的接口，desktop token 鉴权。
   - 验收：OpenAPI 文档生成；Query 契约在 HTTP 层再跑一遍。
9. **[MT] OBS-9 `@openmatel/ui` v0 + 独立 SPA**
   - 范围：Sessions 列表、Session detail（Step Timeline、检查器、diff 视图、命令输出、subagent 树、usage 覆盖率标记、tool 错误标红）、Tool error hotspots、Sources 页。
   - 验收：Storybook 或 Ladle 展示所有 step 类型；UI 只调用 Query API（lint 规则禁止 import store 包）；a11y 基础检查。
10. **[MT] OBS-10 `cli`：`npx openmatel`**
    - 验收：**在一台只装了 Node 22+ 的 Mac（零服务、零 Docker）上，执行 `npx openmatel` 后 60 秒内浏览器能看到本机已有的 Claude Code 和 dsh 会话**，可以点进时间线和 diff；只监听 127.0.0.1；`--sources` / `--data` 参数可用。

### Milestone 2：标准 ingest 与互通（"不依赖 openma 的 agent 也能接入"）
11. **[MT] OBS-11 `sources/otlp`：OTLP/HTTP traces（protobuf + JSON）+ GenAI 映射**
    - 范围：§4.4 的映射规则（invoke_agent / execute_tool / chat + `gen_ai.*.messages` 内容）；logs 可选。
    - 验收：用官方 OTel GenAI 示例和一个非 openma 的 agent（例如 OpenAI Agents SDK 或 LangGraph 加 OTel instrumentation）发送 trace，UI 能显示 turn、tool、LLM 步骤；有映射的 golden 测试。
12. **[MT] OBS-12 `sources/atif` + `sinks/atif-export`**
    - 验收：Harbor 的 `trajectory.json` 能导入并正确显示 subagent；ATIF → canonical → ATIF 往返在 golden 样本上等价。
13. **[MT] OBS-13 `sources/acp` + 把 `AcpTraceObserver` 迁入 OpenMaTel**
    - 范围：ACP NDJSON ingest；`@openmatel/otel-genai`（由 `@openma/common/telemetry` 迁入）；**[COM]** 改为 re-export 并标记 deprecated。
    - 验收：ACP 事件（tool_call_update diff、plan、request_permission、usage_update）都能映射；`@openma/common/telemetry` 原有 API 保持兼容。
14. **[MT] OBS-14 `sinks/otlp-forward` + `sinks/parquet`（+ 可选 `blob/*`）**
    - 验收：可以把 canonical 数据转发到 Langfuse 或 Phoenix 并正确显示；Parquet 能用 DuckDB 直接查询；不配置 blob 时所有功能照常可用。
15. **[MT] OBS-15 `sdk-js` / `sdk-py` 薄 SDK**
    - 验收：10 行代码能发出 session/turn/tool 事件；示例放在 `examples/non-openma-agent/`。

### Milestone 3：服务端多租户与非 CF 部署（"docker compose up，零 openma 组件"）
16. **[MT] OBS-16 `auth`：Org/Project/成员 + project keys（ingest / query）+ 插件接口**
    - 验收：通过 Auth 契约（跨项目隔离）；key 只存哈希，可以轮换和撤销；desktop 模式免登录。
17. **[MT] OBS-17 `stores/postgres` + `bus/pg` + `runtime-node` + Docker 镜像（GHCR，amd64 + arm64）+ compose team 示例**
    - 验收：在 postgres service container 上通过 Sink/Query/Bus 契约；**`docker compose -f examples/docker-compose.team.yml up` 在不运行任何 openma 组件的情况下可用**，`examples/non-openma-agent` 的 trace 能进入 UI；镜像同时有 amd64 和 arm64。
18. **[MT] OBS-18 `stores/clickhouse`（内容列 ZSTD、TTL）+ compose scale 示例 + Helm chart**
    - 验收：通过 Sink/Query 契约；1 千万 step 规模下聚合查询 p95 < 1 s（基准脚本）；TTL 生效。
19. **[MT] OBS-19 Retention / TTL / 删除 API + 审计日志**
    - 验收：content_ttl 和 data_ttl 在三种 store 上行为一致（契约测试覆盖）；支持按 session 删除（满足 GDPR 类请求）。

### Milestone 4：Cloudflare adapter（托管）
20. **[MT] OBS-20 `runtime-cloudflare`：Workers + Queues + D1 控制面 +（D1 或 ClickHouse HTTP）数据 + 可选 R2**
    - 验收：Miniflare e2e 跑通 ingest → queue → store → query 全链路；同一套 Query/Sink 契约在 `stores/d1` 上通过；CF 下不可用的功能（本地文件源）在 UI 和文档里明确标出。
21. **[MT] OBS-21 Hosted 部署流水线（staging / prod）**
    - 范围：可以放进 openma-hosted 的 `deploy*.yml`，或单独建一个 hosted 仓库。
    - 验收：staging 上 OTLP 和 ATIF ingest 冒烟测试通过。

### Milestone 5：openma 集成（openma 只是众多客户端之一）
22. **[COM]+[OMA] OBS-22 修复 usage "缺失 vs 0"（←审计 P0-4）**
    - 范围：`managed-event-projector` 在 usage 缺失时不写 0；openma Timeline 显示 "usage unavailable"。
    - 验收：e2e `acp-deepseek-native-cache` 场景下，缺失的 usage 显示为 "—" 并带提示；有 usage 时行为不变。
23. **[OMA] OBS-23 `packages/obs-emitter`：managed session events → OpenMaTel（Queue consumer，at-least-once）**
    - 范围：CF 和 Node 两套 adapter，用 openma 已有的 queue 端口；按 workspace 配置 OpenMaTel endpoint 和 key。
    - 验收：关闭 emitter 时 openma 行为零变化；开启后 session 在 OpenMaTel 中的 step 与 `derive.ts` 的快照对齐（同一组 fixtures）。
24. **[MT] OBS-24 `auth-openma` 插件（workspace key + accounts.openma.ai OIDC；workspace → project 映射）**
    - 验收：用 openma 账号登录能看到映射到的 project；不启用插件时没有任何 openma 依赖（依赖检查脚本强制）。
25. **[OMA] OBS-25 console 嵌入 `@openmatel/ui`（Trace tab + `/observe/*` 路由；`/v1/oma/observability/token` 换取短期 token）**
    - 范围：合并审计中的 P0-5（tool 错误）、P0-6（LLM 内容）、P0-9（导航）、P1-9（token/成本）。
    - 验收：session 页能打开 Trace tab，显示 tool 错误、LLM 内容、diff、usage 覆盖率；managed `/v1/*` 没有新增任何非 Anthropic 路由。
26. **[OMA] OBS-26 Timeline/Trajectory 迁移（阶段 B → C）**
    - 范围：快照对比后切换默认 tab；trajectory modal 改为 "导出 ATIF"（←P0-1/P0-2 的观测部分；eval 相关部分转给 eval 轨道）。
    - 验收：fixtures 对比没有语义缺失；旧 Timeline 改为 Raw events 视图。
27. **[BC]/[MTY] OBS-27 backchat / Martty 嵌入（library 模式 + UI）与 ACP host 侧 `AcpTraceObserver` 接入**
    - 验收：在 backchat 里打开 "Observe" 面板能看到当前和历史 ACP 会话；不安装任何外部服务。

### Milestone 6：给 eval 服务的契约
28. **[MT] OBS-28 Score 契约与 `processors/score-hook`**
    - 范围：`POST /v1/scores`；webhook 或 queue 投递给外部 eval 服务；UI 展示 score 徽标和来源。
    - 验收：用一个 mock eval 服务完成"收到 step → 回写 score"的闭环；score 能按 grader 和版本区分。

**顺序与工作量**（单人估算）：M1 约 4–5 周 → M2 约 3 周 → M3 约 3 周 → M4 约 2 周 → M5 约 3 周 → M6 约 1 周。M2 和 M3 可以并行（两人时总体约 10–12 周）。

---

## 14. 待用户决策
1. 确认 OpenMaTel 作为独立产品的主仓库和名称（npm scope `@openmatel/*`，镜像 `ghcr.io/openma-ai/openmatel`），以及许可证（建议 Apache-2.0，和 Harbor/agentenv 一致；MIT 也可以）。
2. Hosted 的数据存储：CF Workers + Queues + **ClickHouse Cloud**（推荐），还是先用 D1 小规模试运行。需要 ClickHouse Cloud 账号和预算，或者自建 ClickHouse 的主机。
3. API 位置：采纳"观测 API 由 OpenMaTel 自有域名提供，openma 只保留 `/v1/oma/observability/token`"。
4. 桌面默认存储：SQLite（推荐），DuckDB 作为可选分析层。
5. 默认 capture level：desktop 用 `full`，hosted 新建项目用 `truncated`（建议）。
6. dsh：是否允许把 `DSH_TELEMETRY_OTLP_URL` 指向 OpenMaTel，并要求 dsh 公开 session v4 格式文档；Martty 和 backchat 的会话目录需要维护者确认。

---

## 15. 分层会话模型（Layered session model，2026-10-20 新增）

Agent 会话不是平铺的 span 列表。OpenMaTel 用四层结构表示一个 session。其中 **Segment 和 Turn 是 schema 的一等字段**（每个事件都带 `segment_id` / `turn_id`，Query API 可以按它们过滤和聚合）。

```
Session
 └─ Segment (按 context 边界切分：compaction / resume / fork)
     ├─ [segment boundary node：compaction summary, tokens_before, tokens_after, tokens_removed]
     └─ Turn (从一条用户消息开始，到 agent 交回控制权为止 —— 默认视图；eval score / RL reward 的单位)
         └─ Step：llm_call | tool_call | sandbox op（env.command / env.file_edit / env.browser）| sub-agent（嵌套 session，可钻取）
 (idle-gap marker：只是时间轴上的折叠标记，不是结构)
```

### 15.1 Segment（最外层）
- 新 segment 从以下边界开始：**context compaction**（自动或手动）、**resume**（从磁盘恢复，context 被重新装载）、**fork**（从某个点分叉出新分支）。session 的第一个 segment 是 `seg_0`。
- 边界本身是一个节点（`kind: "segment.boundary"`），attrs 包括：`reason: compaction|resume|fork|unknown`、`context_tokens_before`、`context_tokens_after`、`tokens_removed`、`summary`（compaction summary 的内容，受 capture level 约束）、`parent_segment_id`。
- 来源没有给出某个数值时就写 `null`。可以从相邻 llm_call 推算时，标记 `derived: true`。

### 15.2 Turn（默认视图）
- 从一条真实的用户输入开始（不包括 tool_result、系统注入或 meta 消息），到 agent 交回控制权为止：最终回复、等待用户（permission / question）、被中断，或报错停止。
- Turn 是 **eval score 和 RL reward 挂载的单位**（`Score.target = {session_id, turn_id}`）。
- Turn 汇总：step 数、tool 错误数、usage（覆盖率）、时长（墙钟时长和"活跃"时长，活跃时长扣除 idle gap）、`stop_reason`、signals。

### 15.3 Idle-gap marker（非结构）
- 两个相邻事件间隔超过阈值（默认 **30 min**，可以按项目或在 UI 中配置）时，时间轴把这段时间折叠成一个 marker。它不创建 segment 或 turn，也不进 schema，是查询时或渲染时计算出来的。

### 15.4 Steps
- `llm.call`：一次模型调用，一个 step（见 15.5）。
- `tool.call`：input、output、error、duration，有 retry 链接时带上。
- sandbox op：`env.command`（command、exit_code、stdout/stderr）、`env.file_edit`（path、diff）、`env.browser`。作为 tool.call 的子 step。
- sub-agent：`subagent.spawn` 指向一个 child session（`child_session_id`），UI 可以钻取进去。

### 15.5 Per-source LLM call adapters
每个来源的 normalizer 必须把一次模型调用归一化成**恰好一个** `llm.call` step：

| 字段 | 含义 |
|---|---|
| `provider`, `model` | 未知时为 null；Claude Code 的 `<synthetic>` 不算模型 |
| `usage.input_tokens` | **未命中缓存的**输入 token |
| `usage.cache_read_tokens` / `usage.cache_write_tokens` | 缓存读 / 写 |
| `usage.output_tokens`, `usage.reasoning_tokens` | 输出 / 推理（来源没有区分时，reasoning 为 null） |
| `attrs.context_tokens` | = input + cache_read + cache_write（这次调用看到的完整 prompt 大小）；任一项未知时为 null |
| `attrs.stop_reason`, `attrs.latency_ms`, `attrs.ttft_ms` | 未知时为 null |
| `turn_id`, `segment_id` | 必填 |

规则：**未知 = null，永不为 0**。各来源"input"口径不一样（Codex 的 `input_tokens` 包含 cached；Claude / dsh / pi 不包含），adapter 必须换算成上表的口径。

### 15.6 自动标记的信号（signals）
在 turn 和 session 级别计算（存在 `attrs.signals[]`，可以查询）：
- `repeated_tool_failure`：同一个工具（名称和输入大致相同）连续失败 ≥ 3 次。
- `loop`：同样的 tool 和输入在一个 turn 里重复 ≥ 3 次，或 N 步内反复出现相同的 step 序列。
- `user_interrupt`：用户中断（ESC、cancel、`control.interrupt`）。
- `user_correction`：中断后紧接着用户发消息纠正，或用户消息以否定或纠正开头（启发式，标记 `confidence`）。

### 15.7 Agent 专属视图
- **Context delta**：每个 llm_call 的 `context_tokens` 减去同一 segment 中上一个 llm_call 的值（新增上下文 = 工具输出、用户输入等）。
- **Context watermark 曲线**：按调用序列绘制 `context_tokens`。compaction 处出现下降，segment 边界会标出来；如果来源提供了 context window，就画成上限线。
- **Cache hit ratio**：`cache_read / context_tokens`，按调用、turn、session 计算。
- Token 显示：**"tokens in" = context_tokens**（包含缓存），不再只显示未缓存的 input。这修复了 Claude Code 只显示几百个 token 的问题。

### 15.8 本机实测：各来源暴露了什么（2026-10-20，box 上的真实文件）
| 来源 | compaction / resume / fork | 每次调用的 usage | stop reason | latency / TTFT |
|---|---|---|---|---|
| Claude Code | 格式支持（`isCompactSummary`、`system`/`compact_boundary`），**本机样本中没有出现**；resume 可以从 `parentUuid` 链断裂、新 `sessionId` 推断 | ✅ input / cache_creation / cache_read / output（+ `thinking_tokens`） | ✅ `stop_reason` | 可以从 `api-request` 和 assistant 的时间戳推算 latency（derived）；没有 TTFT |
| Codex | 格式支持 `compacted`，**本机样本中没有出现** | ✅ `token_count.last_token_usage`（input 含 cached、cached_input、cache_write、output、reasoning） | ❌ | ❌ |
| dsh | **本机样本中没有 compaction 记录**；`request/context` 提供 contextWindow | ✅ `assistant/message.usage`（input / output / cacheRead / cacheWrite） | 部分（turn/end reason） | ✅ 可以从 stream chunk 时间推算 TTFT 和 latency |
| pi | ❌ 未见 | ✅ input / output / cacheRead / cacheWrite / reasoning（+ cost） | ✅ `stopReason` | ❌ |
