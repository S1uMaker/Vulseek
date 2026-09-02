# orch-hunt：按 primitive 拼链式洞

> 覆盖并落地 [orch-hunt-roles-for-chained-bugs.md](orch-hunt-roles-for-chained-bugs.md)。那份是职责定义；本文是改哪些文件、改成什么、怎么验收。
>
> Hunt brief 的写法对齐 **tob-goal 现网**：`goalPrompt` 是 outcome-heavy、path-light 的锁箱；成功标准不在每次 Hunt 里重写。差别只有一点：tob-goal Hunt 停在「一个完整洞」；orch-hunt Hunt 停在「钉死一个 primitive」。完整链由 Orch 组。

**Goal:** 拓扑不变。Orch 按 primitive 切面、记账、拼链后 `submit_candidate`。Hunter 只深挖一个可证伪 primitive，feedback 必须带缺口。不再 8 路同时写「找未认证 RCE」。

**Architecture:** 现有 `orch-hunt.yaml`：persistent Orch（`goalSession: shared`，`inputDelivery: poll`）fanOut Hunter；Hunter 只回 `name` + `feedback`；candidate 仍只由 Orch 提交，再进 verify / triage。不改边、不改 queue、不改 driver notify（Goal 全程 watch 已落地）。

**Tech Stack:** `pipelines-v3/orch-hunt.yaml`、`agents/skills/orchestrator/`、可选极薄 hunter skill。Biome + 现有 Vitest / node:test。Commit：`feat(scan): ...`。

## 产品合同（从角色文搬过来，实现必须满足）

- Orch = 研究主管：切 primitive、ledger、拼链、`submit_candidate`。不是第 9 个 Hunter，不跟单个 sink 文件死磕。
- Hunter = 一个 primitive 的深挖：可证伪的一跳，不是迷你 Orch，不 `submit_candidate`，不声明 exhaustion。
- Candidate = entry → primitive(s) → sink → 影响，每段 `file:line`。单 primitive（例如只有 SQLi、只有 batch 错位）不够当未认证 RCE。
- 「sink 在、入口被挡」是资产 → connector hunt，不是结案。
- 不写 PoC / exploit。动态整链验证若以后做，放 candidate 提交之后；Hunter 最多确认 **本 primitive**。
- 动机例（wp2shell）：sink（`author__not_in` 未 `absint`）+ 挡板（REST int array）+ 走私（batch `$matches` 错位）+ 升级（伪造行 → 权限/写文件）。6.8 只有 sink 没有走私；两者都不能当失败丢掉。

## Global Constraints

- 权威定义仍是 `packages/server/src/services/scan/pipeline/definitions/pipelines-v3/orch-hunt.yaml`。只改这一份 V3；不要新开 pipeline。
- **不改拓扑：** `orchestrator-to-hunter` fanOut、`hunter-to-orchestrator` map、`orchestrator-to-verify-finding` 不变。Hunter output 仍是 `{ name, feedback }` 两个字段。
- **不改 candidate JSON schema**（verify/triage 合同）。变的是：Orch 何时提交、提交时链是否写全。
- Hunter `feedback` **保持 string**。用 standing prompt + skill 规定必须能抽出的字段（类型 / file:line / 已证实 / 缺口 / 建议下一个 primitive）。不要为了拼链先上结构化 JSON（避免改边和 Message 校验）。
- Orch 的 standing `/goal` = YAML `runtime.prompt`。ACP 只认 `prompt[0]`：这段必须自洽。调度细则可以进 SKILL.md，但 **spawn-first、按 primitive 派猎、禁止自己当 Hunter** 必须出现在 YAML prompt 里，否则 Goal 长会话会忘掉。
- `goalPrompt` 禁止 `/goal` 前缀；footer 仍由 `orchestrator.py` `ensure_hunter_footer` 追加。Orch 只写研究问题。
- 设 Orch `/goal` 时不要把 hunter 的 skill 列表、schema suffix 拼进同一段（现网 `outputSuffix: omit` 已满足）。
- `runtime-analysis`、Web 实例锁、整链动态利用 **不在本次范围**。角色文第 6 / Hunter 第 4 点只在 prompt 里写成禁令：「不要跑完整建管理员 / 写文件链」。
- 不改 release 编排。不把 wp2shell 写成必猎目标；它只是链式洞的形状说明。

## 两个 `/goal` 在本 pipeline 里怎么用

```
Orch session（一个 / job）
  首次 /goal: 按 primitive 派猎、记账、拼链；禁止自己挖某一 sink
        │  huntTasks[]（每个 goalPrompt = 一个 primitive）
        ▼
Hunter session × N（一个 primitive 一个）
  /goal: {{goalPrompt}} + standing 规则
        │  name + feedback（primitive + blocker）
        ▼
Orch 同一 thread，notify / poll
        └── 更新 ledger → connector hunt 或 submit_candidate
```

不要把「找未认证 RCE」写进 Hunter 的 `/goal`（对应 tob-goal：不要把找洞和切面写进同一段；这里是不要把 **整链** 和 **一跳** 写进同一段）。

## `goalPrompt` 合同（对齐 tob-goal hunt-goal，锁的是 primitive）

写进三处，用同一套话，避免 YAML / skill / schema 各说各话：

1. `orch-hunt.yaml` → `schemas.hunt-task.properties.goalPrompt.description`
2. `orchestrator/SKILL.md` → `spawn_hunters`
3. Surface 式提醒：写在 Orch YAML prompt 里一两句

**必须：**

- 锁 **一个** 可证伪 primitive（query-var 卫生、batch `$matches` 对齐、结果当对象用是否变成写权限，等）
- outcome-heavy、path-light：必须证明什么、排除什么
- 未认证入口如何接到这一跳 **可以是缺口**，不必本跳打穿 RCE
- 调查围着同一 primitive 换方法（手追 + Semgrep/CodeQL，或对比兄弟 API）

**禁止：**

- `/goal` 前缀、submit footer、scan-runtime 操作说明
- 「audit all …」「在 REST 里找到 RCE」
- 把未验证根因写成事实（例如「resolver 不调 check_permissions」）
- 粘整份政策 / GoalSpec JSON、点名必须用某一个工具

**坏例子（现网 luna / qwen 形态，实现后应被 skill 点名禁止）：**

- `Audit all public media/zip/upload paths for unauthenticated RCE... End with the required footer.`
- `/goal ... execute_ability() does NOT call check_permissions() ...`

**好例子：**

```
WP 7.0.1. Primitive: WP_Query author__not_in / author_exclude 卫生。
Prove which query vars are interpolated into SQL without absint/prepare,
and whether REST author_exclude is typed as an int array (where the string is rejected).
Do not prove RCE. If the sink exists but REST blocks strings, report the gate file:line
and what primitive would still feed a raw string into WP_Query.
No PoC. Stay in wp-includes/query + REST posts controller.
```

## 反馈契约（string，但 Orch 必须能抽）

Hunter `feedback` 用短 markdown，至少含：

| 块 | 内容 |
|----|------|
| primitive 类型 | sink / 挡板 / 走私或错位 / 权限升级 |
| location | `file:line` + 符号 |
| 已证实 | 一至数句事实 |
| 缺口 | 还缺哪个 primitive 才能接到未认证入口或接到影响 |
| 建议下一个（可选） | Orch 可改 |

不强制 JSON parse。Orch skill 教「读这些标题；抽不出就当反馈不合格，再派同一 primitive 收窄，不要当没洞」。

## Ledger（`/lane`）

Orch 在 `/lane/` 记 primitive，不记「这个子系统没洞」。建议固定文件，避免每轮换名：

- `/lane/ledger.md`：人读
- 可选 `/lane/primitives.json`：id、类型、location、状态（open / blocked / connected / in-candidate）、来源 hunt name

至少要能回答：哪些 primitive 已确认、哪些缺口还没派、哪些已编进已提交 candidate。后续 hunt 补缺口，不重扫同一 REST 面当「再找一个 RCE」。

## Orch prompt vs skill 写什么

ACP 只把第一次 `prompt[0]` 当成 standing `/goal`。**身份、切面策略、何时算成功、spawn-first** 必须写在 YAML `runtime.prompt` 里；只写在 SKILL.md 会在 Goal 长会话里被忘掉。

SKILL 是操作手册：命令怎么调、字段怎么填、ledger 长什么样。When 逐步清单放 skill，不要把 CLI/JSON 表塞进 `/goal`。

### 写进 Orch YAML `runtime.prompt`（短，一直有效）

| 写什么 | 为什么在 prompt |
|---|---|
| 你是编排者，不是 Hunter；禁止跟单个 sink 死磕 | 身份 |
| 按 **primitive** 派猎；第一波不要 8 路都写「未认证 RCE」 | 切面策略 |
| 有空槽就立刻 spawn，然后再本地读 | spawn-first |
| notify / feedback → 记账、有缺口开 connector、链齐了才 `submit_candidate` | job 怎么推进 |
| job 成功 = 未认证高 CVSS 链；没找到完整 RCE 不是停，也不是 Hunter 的成功 | outcome |
| 不写 PoC；Follow `orchestrator/SKILL.md` | 边界 |
| `goalPrompt` **一两句**：锁一个 primitive，outcome-heavy，禁止 `/goal` 和 footer | brief 硬规则 |

`pollPrompt` 另算，更短：收到 inbound 就 `get_hunter_feedback`，有槽就 spawn；空不是 hang。

**不要写进 YAML prompt：** 命令行、JSON 字段表、ledger 文件格式、feedback 标题模板、goalPrompt 正反例全文、When 七步。

### 写进 Orch `SKILL.md`（操作手册，可翻）

| 写什么 | 为什么在 skill |
|---|---|
| 四条命令怎么调（list / get_feedback / spawn / submit） | CLI |
| `name` 格式、`availableSlots`、footer 由脚本追加 | 协议 |
| `goalPrompt` **完整合同** + 好/坏例子 | spawn 时才需要 |
| feedback 必须能抽出的块（类型 / file:line / 已证实 / 缺口） | 读反馈时才用 |
| ledger 记什么（primitive id、状态、哪些已进 candidate） | `/lane` 格式 |
| **When**：启动 / notify / 有反馈 / 有空槽 都走同一套；spawn 在 submit 前 | 逐步清单 |
| 「打不满 = 资产」；抽不出缺口就再派收窄，不当没洞 | 判读规则 |

When **不要**再写 “each Goal turn / next orchestration pass”。

### 允许 YAML 一句、skill 展开的

这些 **prompt 里一句、skill 里写全**：

- spawn-first
- 按 primitive 派，不按整条 RCE
- `goalPrompt` 禁止 `/goal`、footer、audit-all

Hunter standing 规则在 **hunter YAML prompt**（`{{goalPrompt}}` 后面），不进 orch prompt / skill。

## YAML / skill 要改的行为

### Orch `runtime.prompt`（standing `/goal`）

按上一节「写进 YAML prompt」那张表改，仍短。现网四段（dispatch、unauth、不要停、填槽）换成主管合同：

- 你是编排者，不是 Hunter。按 **primitive** 派猎；第一波不要 8 路都写未认证 RCE。
- 收到 feedback / inbound notify：`get_hunter_feedback`，把 primitive 记进 ledger；有缺口就开 connector；能拼成 entry→…→sink→影响 再 `submit_candidate`。
- **有空槽就立刻 `spawn_hunters`**，然后再本地读。本地读只为写下一批 primitive 或核实已交链，禁止跟单个文件死磕到不 refill。
- 未认证高 CVSS 仍是 **job** 成功条件；「没找到完整 RCE」不是停，也不是 Hunter 的成功条件。
- 不写 PoC。Follow `orchestrator/SKILL.md`。

`pollPrompt` 补一句：inbound notify = 现在就 `get_hunter_feedback`；有空槽就 spawn。空结果不是 hang。

### Orch SKILL.md

重写 **When**：每次决策（启动、notify、feedback 非空、slots 变多）都走同一套，不要写「each Goal turn / next orchestration pass」。

顺序：

1. `list_hunters`
2. `get_hunter_feedback`（空 = 这次没新结果）
3. 更新 ledger（primitive + 缺口）
4. **`availableSlots > 0` → 立刻 spawn 填满**（移到 submit 前）
5. 链完整才 `submit_candidate`
6. 槽满后才允许本地读（写下一批 primitive / 核实链）
7. 禁止 slots>0 还深挖；禁止等 next pass

`spawn_hunters` 节贴上 `goalPrompt` 合同 + 正反例。`get_hunter_feedback` 节贴上反馈块。明确：打不满 = 资产。

### Hunter `runtime.prompt`

保留 `{{goalPrompt}}` + assigned name。Standing 规则改成 tob-goal Hunt 那种固定段，但成功条件是 primitive 不是完整洞：

- `/goal` 保持到 **本 primitive** 有证据（含「挡板 file:line」这种负向证据）
- 围着同一 primitive 至少换一种方法
- 禁止为了结束而交投机 RCE
- `feedback` 必须带类型 / location / 已证实 / 缺口
- 不 `submit_candidate`、不声明 exhaustion、不写 PoC
- 不跑完整利用链

`includePolicy: false` 保持；排除项由 Orch 写进该次 `goalPrompt`。

### Schema description

- `hunt-task.goalPrompt`：按上面合同改 description（仍是 `string` `minLength: 1`）
- Hunter `feedback` description：列出必须出现的块
- Orch / Hunter `description` 字段：从「hunt slice / 完整漏洞」改成 primitive / 拼链

## 文件清单

| 文件 | 职责 |
|------|------|
| `plans/orch-hunt-roles-for-chained-bugs.md` | 职责原文；本 plan 覆盖它，不删 |
| `packages/server/src/services/scan/pipeline/definitions/pipelines-v3/orch-hunt.yaml` | Orch/Hunter prompt、pollPrompt、hunt-task / feedback description、stage description |
| `agents/skills/orchestrator/SKILL.md` | When 顺序、goalPrompt 合同、ledger、反馈块 |
| `agents/skills/orchestrator/orchestrator.py` | 仅当 footer 文案与 Hunter standing 冲突时改 `HUNTER_SUBMIT_FOOTER`（仍只追加 submit-message，不改语义） |
| `agents/skills/goal-hunt/SKILL.md` 或新建 `agents/skills/hunter/SKILL.md` | **不要**除非 YAML standing 放不下。优先 YAML，避免 skill 与 `/goal` 抢通道 |
| 测试见下 | |

## 实现任务

### Task 1: YAML 合同（prompt + schema 文案）

**Files:** `orch-hunt.yaml`

- [ ] 改 Orch `runtime.prompt` 为主管 `/goal`，内容仅限「Orch prompt vs skill」里 YAML 那张表（身份、primitive 切面、spawn-first、拼链才 submit、禁止自己当 Hunter）。不要把 CLI/JSON/正反例写进 prompt。
- [ ] 改 `pollPrompt`：notify → `get_hunter_feedback` + 有槽就 spawn。
- [ ] 改 Hunter standing 段（primitive + 缺口 + 两种方法 + 不交 candidate）。
- [ ] 改 `hunt-task.goalPrompt`、Hunter `feedback`、两个 stage `description`。
- [ ] 跑 `scan-pipeline-definitions.test.ts` / YAML contract 测试。

### Task 2: Orchestrator skill

**Files:** `agents/skills/orchestrator/SKILL.md`，必要时 `orchestrator.py` footer。

- [ ] When 改为「每次决策」+ spawn 在 submit 前（skill 里写全七步，不要写 each Goal turn）。
- [ ] `goalPrompt` 完整合同与正反例放 skill；YAML 里只留一两句硬规则。
- [ ] ledger 记 primitive id；反馈块标题和「打不满 = 资产」放 skill。
- [ ] footer 仍只负责 submit-message；不要让 Orch 再手写 footer。

### Task 3: 契约测试

**Files:** 新建例如 `packages/server/src/services/scan/pipeline/orch-hunt-primitive-chain.test.ts` 或 `apps/vulseek/__test__/scan/orch-hunt-primitive-chain.test.ts`（读 YAML + SKILL 源码即可）。

- [ ] Orch prompt 含 primitive、spawn、禁止自己 hunt；不含「8 路找 RCE」式旧句。
- [ ] Hunter prompt 含缺口 / 不 declare exhaustion；`{{goalPrompt}}` 仍在。
- [ ] SKILL 含 spawn-before-submit、goalPrompt 禁止 `/goal`、ledger primitive。
- [ ] hunt-task.goalPrompt description 含 outcome-heavy 或等价锁箱用语。

## 明确不改

- Pipeline 边、Hunter output 字段集、candidate schema、verify/triage 逻辑。
- `vulseek-acp-driver.mjs` notify watcher（已按 Goal 全程 watch）。
- 给 Orch 加 `securitycontext` MCP（可选后续：known-CVE vs original）。
- Craft 式独立 GoalSpec stage（Orch prompt + policy 就是 job 级合同）。
- runtime-analysis / 实例锁 / 完整利用链。
- UI。

## 验收

1. 源码合同测试全绿；orch-hunt YAML 仍加载为合法 V3。
2. 人工读：Orch `/goal` 看起来像 tob-goal Surface（不挖洞、派锁箱）；Hunter `/goal` 像「一个 primitive + standing 规则」，不像「找 RCE」。
3. 角色文里的 wp2shell 四段 primitive，都能写成合法 `goalPrompt` 而不提 RCE；挡板反馈按合同能触发 connector，而不是结案。
4. 不要求本 PR 用新 prompt 跑完一个 WP job；那是后续扫描验证。
