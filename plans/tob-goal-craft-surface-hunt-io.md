# TOB Goal：Craft / Surface / Hunt 输入输出与 `/goal` 循环

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文修订 [tob-goal-pipeline.md](tob-goal-pipeline.md) 里 Craft / Surface / Hunt 的契约，并对照 [trail-of-bits-goal-bug-hunting.md](trail-of-bits-goal-bug-hunting.md)。Judge / Dedup / Report 的判定逻辑不改，只改它们转发的 GoalSpec 通道（内联对象改为 path）。

**Goal:** 让 Craft 只产出一份 GoalSpec 文件；Surface 与 Hunt 各自以 native `/goal` 跑两个不共享的循环；stage I/O 去掉双写和抢 outcome 的字段。

**Architecture:** Craft 编译判定合同（不看威胁方向表单、不写 Hunt `/goal`）。Surface 是 job 级 planner session，首次把 **stage definition 的 prompt** 作为 native `/goal` 正文，之后只收 feedback。Hunt 是一面一个 finding session，同样用 **该 stage 的 prompt** 作为 `/goal` 正文（可读 GoalSpec / huntGoal 文件，不由 TypeScript 拼字段）。两套 `thread_goals` 不共享；共用的只有 GoalSpec 文件。

**Tech Stack:** Pipeline V3 YAML（`pipelines-v3/tob-goal.yaml`）、generic agent runtime、Codex ACP `/goal`、`$pathOf` artifact 拷贝。

## Global Constraints

- 权威定义：`packages/server/src/services/scan/pipeline/definitions/pipelines-v3/tob-goal.yaml`。V2 `definitions/pipelines/tob-goal.yaml`、`definitions/schemas/tob-goal.yaml`、`definitions/stages/tob-goal.yaml`、`prompts/goal-*.prompt.md` 必须同步，禁止只改一处。
- `full.yaml` / `delta.yaml` / `research.yaml` 里若仍内嵌同一份 `goal-*` schema，一并改，避免 workbench 打开别的 pipeline 看到旧字段。
- **禁止用代码拼装 `/goal` 正文。** 不要用 `buildHuntGoalPrompt` / `buildSurfacePlannerGoalPrompt` / `buildGoalPrompt` 把 GoalSpec 字段、huntGoal、YAML、input dump 拼成一段。`goal: true` 的 stage 把 **stage definition 的 `runtime.prompt`**（仅做已有的 `$input.` / `$ctx.` 模板渲染）当作 goal 文本；runtime 最多加上前缀 `/goal `（若原文尚未以 `/goal` 开头）。
- Native `/goal` 正文 ≤ 4000 字符（Codex ACP 上限）。GoalSpec、hunt 范围、schema 合同走 **文件**（`inputs/goal-spec.json`、`task-input.json`、`output.schema.json`），由 prompt 里用路径引用，不要在 TypeScript 里展开字段。
- ACP 只看 `session/prompt` 的 **`prompt[0]`**（见下文「ACP `/goal` 行为」）。若命令被处理会 `end_turn`，`prompt[1]` 及之后会被丢掉。因此 `/goal` 必须自洽。回环 **禁止** 再发 `/goal`。
- 设 `/goal` 的那一次，**不要**把 skill 列表、security policy、output-schema suffix 拼进同一个 `prompt[0].text`。那些会变成 goal 目标的一部分。suffix / policy 走文件或后续非 `/goal` turn。
- `goal: true` 不再隐含「每 task 新容器」。Surface 必须同一 container / 同一 thread 跨回环；Hunt 仍一面一容器。
- Craft **不**输入 `threatDirection`。不把该字段加入 `goal-craft` 的 inputSchema。删除 UI / `scanRuntimeSettings.threatDirection` 不在本计划必做范围。
- Biome + 现有 Vitest / node:test。Commit 用 Conventional Commits，例如 `feat(scan): ...`。
- 不改 release 编排（33000）。

---

## 两个 `/goal` 循环

```
Surface session（一个 / job）
  首次 /goal: 切面直到全局耗尽；禁止挖洞
        │  huntGoals[]（范围）
        ▼
Hunt session × N（一面一个）
  /goal: 在这个范围内达成 GoalSpec
        │  candidate | exhausted
        ▼
Judge / Dedup（非 goal）
        │  feedback（事实，不改 /goal）
        └──► Surface 同一 thread，普通 turn
```

| | Surface | Hunt |
|---|---|---|
| 循环对象 | 尚未覆盖的攻击面 | 一个已派发的面 |
| `/goal` 何时 set | 整次 job 一次 | 每个 hunt session 一次 |
| 成功 | 再派未覆盖的面，或 `globalExhausted` | 恰好一个达标 candidate，或此面穷尽 |
| 并行 | concurrency 1，回环排队 | fanOut，多面并行 |
| 停 | 全局没有新面 | 一面结束，job 可以继续 |

不要把「找洞」和「切面」写进同一段 `/goal`（ToB zlib 双目标失败模式）。两段 goal 文本分别写在 `goal-surface` 与 `goal-hunt` 的 `runtime.prompt` 里，由编辑器维护，不由 runner 生成。

---

## ACP `/goal` 行为（已核对）

Driver（`vulseek-acp-driver.mjs`）每次只发 **一个** content part：

```js
prompt: [{ type: "text", text: promptText }]
```

Codex ACP 1.1.2（`@agentclientprotocol/codex-acp`）的 `parseCommand` **只读 `prompt[0]`**：

- 若 `prompt[0].text` trim 后以 `/goal` 开头，则 **该字符串里 `/goal` 后面的全部剩余文本**（含换行，再 `trim()`）作为 `thread/goal/set` 的 objective，上限约 4000 字符。
- **不是**「`/goal` 后面到第一个空行为止的第一段」。空行不会切开 goal 与 follow-up。
- 若 slash command 被处理，适配器 `end_turn`，**`prompt[1]` 及之后全部丢掉**。

Claude Code ACP 对第一块文本用 `/^\/goal(?:\s+([\s\S]*))?$/`，同样是整段剩余文本，不是第一段。

因此「第一个文本框」= ACP 的第一个 content part = 我们 driver 里的整份 `promptText`。要把 stage prompt 当 goal，runtime 应发送：

```
/goal <exactly the rendered stage prompt>
```

不要在后面用 `\n\n` 再接 YAML / schema / input；那仍在同一个文本框里，会全部变成 standing objective。

---

## 字段决策

### Craft

**输入 `goal-craft-input`**

| 字段 | 决策 |
|------|------|
| `scanJob` | 留下（`scan-job-snapshot`） |
| `threatDirection` | **不要** |
| `repositoryPath` | 不进 schema。容器可挂仓库供命名具体化，但不是驱动字段 |

**输出 `goal-craft-output`**

| 字段 | 决策 |
|------|------|
| `goalSpecPath` | 留下，类型 `$pathOf: "#/schemas/goal-spec"`，默认写 `/task/goal-spec.json` |
| `goalSpec` 内联 | **删除** |

**`goal-spec`**

| 字段 | 决策 |
|------|------|
| `goalId` `title` `successCriteria` `nonGoals` `attackerModel` `stopCondition` `persistenceLanguage` `redTeamClosedLoopholes` | 留下，必填 |
| `goalPrompt` | **删除**（不再当所有 Hunt 共用的 `/goal`） |
| `surfaceGuidance` | **新增，可选**。给 Surface 的切面说明（什么叫高价值面、建议维度）。不是 Hunt `/goal` |

Craft 非 persistent，**不要** `goal: true`。自红队只改这份 spec。

### Surface 输入 `goal-surface-input`

| 字段 | 决策 |
|------|------|
| `goalSpecPath` | 留下，`$pathOf: "#/schemas/goal-spec"` → artifact `inputs/goal-spec.json` |
| `goalSpec` 内联 | **删除** |
| `repositoryPath` | **新增**，`$pathOf: "#/schemas/repository"`。现依赖 `cwd` + Craft 的 prepare，Hunt 换容器后不可靠 |
| `feedback` | 留下；首次 `null`，回环必填 |
| `feedback.kind` `summary` `huntGoalId` `candidateId` | 留下；`candidateId` 在 exhausted 时为 `null` |
| `feedback.payload` 无结构 object | **收紧**：只允许 `rootCauseKey`、`coveredPaths`、`methodsTried`（均可选） |
| `feedback.kind: hunt-candidate` | **删除**。candidate 同时进 Judge，Surface 此时不知是否 FP。外循环只反应 `hunt-exhausted`、`judge-reject`、`dedup-novel`、`dedup-reject` |
| `scanJob` / `threatDirection` | 不要 |

### Surface 输出 `surface-dispatch` / `hunt-goal`

| 字段 | 决策 |
|------|------|
| `globalExhausted` `huntGoals` | 留下，必填。耗尽时 `huntGoals` 必须 `[]` |
| `exhaustionReason` | 留下；`globalExhausted=true` 时必填（schema 用 if/then 或 prompt+校验约定；优先 JSON Schema `if`） |
| `partitionDimension`（dispatch 级） | 留下。下一轮换切法 |
| `huntGoal.huntGoalId` `title` | 留下，必填 |
| `huntGoal.objective` | **删除**（抢 GoalSpec outcome） |
| `huntGoal.scopeStatement` | **新增，必填**。一句话锁箱，给 Hunt `/goal` 范围段。不是新的 successCriteria |
| `huntGoal.focusPaths` | 留下，升必填（非路径型面允许 `[]`） |
| `huntGoal.riskPathways` | 留下，可选 |
| `huntGoal.rationale` | 留下（压缩后 JSON 里还要能回忆为何派这面） |
| `huntGoal.partitionDimension` | **从 item 上删除**，只留 dispatch 级 |
| envelope `route` | 保持 `null` |

### Hunt 输入 `goal-hunt-input`

| 字段 | 决策 |
|------|------|
| `goalSpecPath` | 留下，`$pathOf`，与 Surface 同一份文件 |
| `goalSpec` 内联 | **删除** |
| `huntGoal` | 留下（新形状：含 `scopeStatement`，无 `objective`） |
| `repositoryPath` | **新增**，`$pathOf`。`goal: true` 一面一容器，必须自己有仓库 |

### Hunt 输出 `goal-hunt-output`

| 字段 | 决策 |
|------|------|
| envelope `route` = `candidate` \| `exhausted` | 留下，真正分流 |
| `output.outcome` | **删除**（与 route、payload 谁非空三重重复） |
| `candidate` / `exhaustion` 互斥 | 留下，**两字段都 required**，未选中的必须 `null` |
| `exhaustion.exhausted: const true` | **删除** |
| `huntGoalId`（candidate 与 exhaustion 上都有） | 留下，必须等于 input |
| candidate：`title` `description` `location` `claim` `rootCauseKey` | 留下，必填 |
| `vulnerabilityClass` `attackerControl` `preconditions` `quickDisproofAttempt` | 留下，可选 |
| `evidence` 无结构 `object[]` | **改为 `string[]`**（每条一个事实） |
| `confidence` | **删除** |
| exhaustion：`methodsTried` `coveredPaths` `reason` | 留下，必填 |

---

## Native `/goal` 正文 = stage definition prompt

**不要**在 `goal-prompt.ts` 里用 GoalSpec / huntGoal 字段拼一段新目标。权威文本就是 workbench / YAML 里该 stage 的 `runtime.prompt`。

Runtime 对 `goal: true` 的首次（Hunt：每个 session 一次；Surface：`feedback == null`）只做：

1. 按现有规则渲染模板（`$input.huntGoal.scopeStatement` 等 **作者写在 prompt 里的** 占位符可以保留）。
2. 若结果尚未以 `/goal` 开头，前缀 `/goal `。
3. 将该字符串作为 **唯一** 的 `prompt[0].text` 发给 ACP。不要 append schema suffix、policy、skill 列表、input dump。

**Surface `runtime.prompt` 应直接写成 planner 目标**（示例，以 YAML 为准，不由代码生成）：

```
以 /task/inputs/goal-spec.json 为透镜，持续派出未覆盖的高价值攻击面。
禁止自己挖洞，禁止改写 GoalSpec。
每轮产出 2–8 个新 huntGoal，或诚实声明 globalExhausted。
huntGoal 只锁范围（scopeStatement + focusPaths），成功标准以 GoalSpec 为准。
```

回环：普通 turn（feedback 自然语言 + 「继续执行已设定的 planner goal」）。**不要**再前缀 `/goal`，也不要用另一套 TypeScript 模板当 goal。

**Hunt `runtime.prompt` 应直接写成 finding 目标**，用路径指向合同和范围，而不是让 runner 展开字段：

```
Read /task/inputs/goal-spec.json (successCriteria, attackerModel, nonGoals, stopCondition, persistenceLanguage).
Stay inside the assigned surface in the task input (scopeStatement + focusPaths).
Emit exactly one candidate that meets the GoalSpec, or a justified exhaustion.
Do not leave the assigned paths. Do not invent a second success criterion.
```

若作者希望把 `$input.huntGoal.scopeStatement` 写进 prompt，那是 YAML 模板，不是 `buildHuntGoalPrompt`。删除 Hunt YAML 里「runtime 会把 GoalSpec + surface 激活为 `/goal`」和手写 Structured JSON 整节；envelope 以 `/task/output.schema.json` 为准，但 **不要把 schema 协议拼进 `/goal` 那一次的 prompt[0]**。后续 recovery turn 可以发非 `/goal` 的校验提示。

---

## 提示词

权威正文放 V3 YAML `runtime.prompt`（这就是 native `/goal` 正文）。`prompts/goal-*.prompt.md` 若仍存在必须与 YAML 同义。v17 已去掉 stage skill：不要把行为规则放到 SKILL.md 当主通道。

### Craft

- 删除「Honor threatDirection」「return goalSpecPath plus the goalSpec object」「goalPrompt 作为 Codex `/goal`」。
- 改为：根据仓库与本 prompt 编译 GoalSpec；自红队堵口；把 JSON 写到 `/task/goal-spec.json`；output 只有 `goalSpecPath`。
- 可选写 `surfaceGuidance`。不要规定 Hunt 用什么工具。

### Surface

`runtime.prompt` **就是**首次 `/goal` 正文。不要再声明「this stage is launched as `/goal`」。写清透镜、禁止挖洞、2–8 面 / `globalExhausted`、`scopeStatement`+`focusPaths`、禁止 `objective`。回环另发非 `/goal` 的短 turn（feedback），不改这段 goal 文本。

`includePolicy: true` 可留，政策走文件，不进 `/goal`。`prepareRepository`：Surface 首次需要仓库，设为 `target`（或与 Hunt 相同），不要再依赖 Craft 容器。

### Hunt

- `runtime.prompt` **就是**该 Hunt session 的 `/goal` 正文。删掉「runtime 会把 Craft GoalSpec + hunt surface 拼成 `/goal`」。
- 删掉整节 Structured JSON output requirement（会污染 `prompt[0]`）。
- 行为写进这段 prompt：读 GoalSpec 文件；锁在 assigned surface；恰好一个 candidate 或带 methodsTried+coveredPaths 的耗尽；「没找到」不是成功。
- `includePolicy: false` 保持。`prepareRepository: target`。

---

## 运行时

文件：

- `packages/server/src/services/scan/stages/goal-prompt.ts`
- `packages/server/src/services/scan/stages/goal-prompt.test.ts`
- `packages/server/src/services/scan/stages/generic-agent.stage.ts`
- `packages/server/src/services/scan/pipeline/pipeline-runner.ts`（`resolveStageReuseContainer` 约 173–187 行）

**1. 拆开 `goal: true` 与换容器**

现在 `generic-agent.stage.ts` 与 `pipeline-runner.ts`：`goal === true` → `reuseContainer=false` 且 containerName 带 `taskId`。这对 Hunt 正确，对 Surface 会打断 persistent 回环。

改为：

- Hunt（`goal: true` 且 **非** persistent 多 entry 调度器）：保持一面一容器（继续把 `taskId` 编进名字、不 reuse）。
- Surface（`goal: true` **且** `persistent: true` 且 concurrency 1）：尊重 `reuseContainer: true`，containerName **不要**加 `taskId`，同一 lane/thread 跨 task。

不要用「所有 goal stage 都换容器」一刀切。推荐显式：仅当 `goal && !persistent` 时强制新容器；`goal && persistent` 走配置的 reuse。Hunt 当前是 `persistent: true` 一面一 session——一面仍要隔离。因此不能单靠 `persistent`。

更稳的判定：

- Surface：`id === "goal-surface"`（或未来 `runtime.goalSession: "shared" | "per-task"`）。本计划用 `runtime.goalSession`：
  - `per-task`（Hunt 默认）：新容器 + 每 task 新 `/goal`
  - `shared`（Surface）：reuse + 仅首次 `/goal`

**2. `/goal` 文本 = 渲染后的 stage prompt，禁止字段拼装**

删除（或不再调用）`buildHuntGoalPrompt`、`buildSurfacePlannerGoalPrompt`、以及把 YAML+input dump 塞进 `/goal` 的 `buildGoalPrompt`。

`generic-agent.stage.ts` 在 `input.config.goal` 时：

- Surface 首次 / Hunt 每个 session：`/goal ` + `renderedPrompt`（仅模板变量，不拼接 GoalSpec 对象）。**不要**再 concat schema suffix、policy、skill prepend。
- Surface 回环：`isSurfaceGoalReentry` 为真时发非 `/goal` 的短 continuation（feedback），沿用已 set 的 `thread_goals`。
- 允许的「拼」只有：可选的 `/goal ` 前缀、以及作者写在 YAML 里的 `$input.` / `$ctx.` 替换。

**3. 边与 artifact**

`goal-craft-to-goal-surface`：

```yaml
input:
  goalSpecPath: $output.goalSpecPath
  repositoryPath: $ctx.repositoryPath   # 按现有 scan context 实际表达式替换
  feedback: null
artifacts:
  - from: $output.goalSpecPath
    to: inputs/goal-spec.json
    inputField: goalSpecPath
    required: true
```

所有 Surface 回环边：删除 `goalSpec: $input.goalSpec`；保留 `goalSpecPath` artifact；删除 `goal-hunt-candidate-to-goal-surface` 整条边。

`goal-surface-to-goal-hunt`：

```yaml
input:
  goalSpecPath: $input.goalSpecPath
  repositoryPath: $input.repositoryPath
  huntGoal: $item
```

Judge / Dedup 边同样删除内联 `goalSpec`，只转发 path。

`repositoryPath` 的具体 `$ctx.` / 根注入字段以实现时 pipeline-runner 根任务输入为准；若根任务没有该字段，从现有 `prepareRepository` 约定补一个与 full scan 相同的 repository artifact。

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `packages/server/src/services/scan/pipeline/definitions/pipelines-v3/tob-goal.yaml` | schema、stage prompt、`goal: true`、`goalSession`、边 |
| `packages/server/src/services/scan/pipeline/definitions/schemas/tob-goal.yaml` | V2 同构 schema |
| `packages/server/src/services/scan/pipeline/definitions/pipelines/tob-goal.yaml` | V2 边映射 |
| `packages/server/src/services/scan/pipeline/definitions/stages/tob-goal.yaml` | V2 stage 标志 / promptFile |
| `packages/server/src/services/scan/prompts/goal-craft.prompt.md` | Craft 提示 |
| `packages/server/src/services/scan/prompts/goal-surface.prompt.md` | Surface `/goal` 正文（与 YAML 同义） |
| `packages/server/src/services/scan/prompts/goal-hunt.prompt.md` | Hunt `/goal` 正文（与 YAML 同义） |
| `packages/server/src/services/scan/stages/goal-prompt.ts` | 仅保留 `/goal ` 前缀、Surface 回环检测与 continuation；删除字段拼装 |
| `packages/server/src/services/scan/stages/generic-agent.stage.ts` | 首次 `/goal ` + stage prompt；回环 continuation；reuse |
| `packages/server/src/services/scan/pipeline/pipeline-runner.ts` | reuse / container 名 |
| `packages/server/src/services/scan/pipeline/document-v3/pipeline-document-v3.ts` 等 | 若新增 `runtime.goalSession`，补 Zod |
| `packages/server/src/services/scan/pipeline/definitions/pipelines-v3/{full,delta,research}.yaml` | 内嵌旧 schema 同步 |
| 测试见下节 | |

---

## 实现任务

### Task 1: Schema 与边（V3 + V2 同步）

**Files:** 上表 YAML schema / pipeline / stages。

- [ ] 按「字段决策」改 `goal-spec`、`goal-craft-output`、新增 `goal-craft-input` / `goal-surface-input` / `goal-hunt-input`。
- [ ] `hunt-goal` 用 `scopeStatement` 替换 `objective`；去掉 item 级 `partitionDimension`。
- [ ] `surface-feedback` 收紧 payload；enum 去掉 `hunt-candidate`。
- [ ] `goal-hunt-output` 去掉 `outcome` 与 `exhausted` const；candidate/exhaustion 都 required。
- [ ] `evidence` 改为 `string[]`。去掉 `confidence`。
- [ ] Craft/Surface/Hunt 的 `inputSchema` 从空 `object` 改为 `$ref` 到上述 input schema。
- [ ] `goal-surface` 设 `goal: true`，`runtime.goalSession: shared`（若尚未有该字段则先加 Zod，默认 Hunt `per-task`）。
- [ ] 改边：删除内联 `goalSpec`、删除 hunt-candidate→surface 边；转发 `goalSpecPath` + `repositoryPath`。
- [ ] 跑 `packages/server/src/services/scan/pipeline/scan-pipeline-definitions.test.ts`、`scan-pipeline-yaml-contracts.test.ts`、`tob-goal-route-selection.test.ts`。更新后者：candidate 路由不再包含回到 surface 的 hunt-candidate 边。

### Task 2: `/goal` 使用 stage prompt 与容器策略

**Files:** `goal-prompt.ts`、`generic-agent.stage.ts`、`pipeline-runner.ts`、对应 test。

- [ ] 重写 `goal-prompt.test.ts`：goal stage 的发出文本 = `/goal ` + stage prompt 渲染结果；**不含** TypeScript 拼出来的 `Success criteria:` / 内联 GoalSpec JSON；Surface 回环 **不以** `/goal` 开头；长度 ≤ 4000。
- [ ] `generic-agent`：goal 首次 turn 使用渲染后的 stage prompt；停止调用字段拼装函数。
- [ ] `goalSession: shared` 时不强制 `reuseContainer=false`、不把 `taskId` 编进容器名；`per-task` 保持现状。
- [ ] 设 `/goal` 时不要把 output-schema suffix 拼进同一 `prompt[0]`。
- [ ] 跑 `goal-prompt.test.ts` 与 reuse 相关测试。

### Task 3: 提示词（即 `/goal` 正文）

**Files:** V3 inline `runtime.prompt`、`prompts/goal-*.prompt.md`（保持同义）。v17 已去掉 stage skill，不要把规则写回 SKILL.md。

- [ ] 把 Surface / Hunt 的 `runtime.prompt` 写成可直接当作 `/goal` 的目标（引用文件路径，不写「runtime 会拼装」）。
- [ ] Surface / Hunt `prepareRepository: target`。
- [ ] Craft prompt 不再提 `threatDirection` / `goalPrompt` / 内联 `goalSpec`。

### Task 4: 契约测试与路由

**Files:** `tob-goal-route-selection.test.ts`、pipeline YAML contract tests、若有 schema snapshot。

- [ ] 断言 `goal-hunt` 的 candidate 出边只有 Judge（外加若仍存在的其它非 surface 边），exhausted 出边只有 Surface。
- [ ] 断言 craft→surface 的 input mapping 不含 `goalSpec`。
- [ ] 断言 hunt-goal required 含 `scopeStatement` 不含 `objective`。

---

## 明确不改

- Judge / Dedup 的判定字段与双裁判产品差异（计划原文仍是双裁判，实现已是单 Judge——不在本次范围）。
- 删除 `scanRuntimeSettings.threatDirection` UI（Craft 不读即可；UI 残留可另开）。
- ACP driver 改成 `prompt[1]` 第二段（本次用「`/goal` 自洽 + 文件/suffix」绕过）。
- Research / full scan 的非 tob-goal 阶段。

---

## 验收

1. Schema：Craft 输出只有 path；Surface/Hunt 输入无内联 GoalSpec；无 `goalPrompt` / `objective` / `confidence` / `hunt-candidate`。
2. Surface `goal: true` 且 persistent 回环仍落在同一容器/thread；第二次 prompt 不以 `/goal` 开头。
3. Hunt / Surface 首次 `/goal` 等于 `/goal ` + 该 stage 的 `runtime.prompt`（模板渲染后），长度 < 4000；同一 `prompt[0]` 不含 schema suffix / policy / skill 列表。
4. 现有 tob-goal 路由测试与 pipeline YAML 加载测试全绿。
