# TOB Goal Pipeline

> 基于 [Trail of Bits `/goal` bug-hunting 实践](trail-of-bits-goal-bug-hunting.md) 设计的新型 scan pipeline。
>
> Craft / Surface / Hunt 的输入输出、`/goal` 循环与字段增删已改订于 [tob-goal-craft-surface-hunt-io.md](tob-goal-craft-surface-hunt-io.md)。下文 Stage 详情里的旧 I/O（threatDirection、内联 goalSpec、huntGoal.objective、共用 goalPrompt）以那份为准。

## 设计原则

1. **Define the outcome, not the path** — pipeline 只定义"什么算成功"，不规定"怎么找到"
2. **One agent, one outcome** — 每个 agent 只有一个清晰目标，多指标在一个 stage 里互相冲突
3. **Persistence in the goal, not in routing** — 持久化编码在 goal 文本和 persistent agent session 里
4. **Quality beats quantity** — "恰好一个高质量 finding" 优于 "尽可能多的 candidate"
5. **Self-red-team the goal before the hunt** — 让 agent 攻击自己的 goal，先堵上"偷懒后门"

## Pipeline 概览

```
goal-craft ──► goal-surface (persistent, multi-entry) ──(fanOut)──► goal-hunt (persistent) ──► goal-judge (dual) ──► goal-dedup ──► goal-report
                         ▲                                                    │
                         └──────────────── 所有面耗尽，零 finding ──────────────┘
```

6 个 stage，DAG + 1 条 back edge。

**持久化设计：** `goal-surface` 和 `goal-hunt` 都是 persistent。前者跨轮维护攻击面探索的完整上下文，后者在一个固定攻击面上迭代。两者各有各的持久化理由，不共享容器。

| Stage | 持久化 | 理由 |
|-------|:------:|------|
| goal-craft | ✗ | 单轮结构化任务，产出 goal spec 即结束 |
| goal-surface | ✓ | 跨轮接收 hunt 反馈，调整攻击面策略，上下文持续积累 |
| goal-hunt | ✓ | 单面内多轮迭代，换方法/深入追踪，需要记住试过什么 |
| goal-judge | ✗ | 独立判定，每次 fresh 确保无偏见 |
| goal-dedup | ✗ | 单次搜索即可 |
| goal-report | ✗ | 非 AI，纯编译 |

## Stage 详情

### 1. `goal-craft` — Goal 编写 + 自红队

| 属性 | 值 |
|-------|-----|
| 角色 | scan |
| 并发 | 1 (serial) |
| 容器 | reuseContainer, 非 persistent |
| 输入 | 人类威胁方向（目标仓库、关心的漏洞类型、攻击者模型） |
| 输出 | 精炼后的 `GoalSpec`（成功标准 + 非目标 + 持久化语言） |

流程：
1. 摄入人类输入的威胁方向、目标约束、攻击者假设
2. 草拟具体 goal prompt
3. **自红队**：列出未来 run 可能"投机取巧"的方式（满足 goal 字面但不做真实工作），逐一修订 criteria 堵上
4. 产出最终 goal spec

对齐 TOB 技巧 #1: Let Codex write the goal.

### 2. `goal-surface` — 攻击面识别与排序

| 属性 | 值 |
|-------|-----|
| 角色 | scan |
| 并发 | 1 (serial) |
| 容器 | **persistent: true**, reuseContainer |
| 输入 | goal spec + 代码库 + （后续轮次）hunt 反馈 |
| 输出 | 排序后的 N 个攻击面清单 `SurfaceList`，或全局耗尽声明 |

流程：
1. **首轮**：基于 goal spec，阅读代码库结构，识别高价值攻击面，按与 goal 的相关性和风险排序
2. **fanOut** 到 `goal-hunt`，每个面一个 agent
3. **挂起等待**：所有 hunt instance 完成后，收集结果（candidate 或 exhausted）
4. **后续轮次（back edge）**：如果所有面耗尽且零 valid finding，agent 被重新唤醒
   - 在同一个 persistent session 中，agent 知道**上一轮选了哪些面、每个面用了什么方法、为什么没找到**——不只是 facts，还包括推理过程
   - Agent 反省上一轮的划分策略，自主决定换什么角度（模块→数据流、数据流→外部接口、…）
   - 产出新的攻击面，确保不与历史覆盖区域重叠
5. **声明全局耗尽**：当多轮后无法找到任何新的、与 goal 相关且未覆盖的攻击面时，输出 `exhausted: true`，pipeline 终止

**为什么 persistent：**

| 方式 | 能力 |
|------|------|
| artifact 传 JSON | 传**事实**：覆盖了哪些路径、用了什么方法 |
| persistent session | 传**上下文**：为什么选那些面、哪个方向上感觉还有没挖到的东西、上一轮划分策略的反思 |

第二个更接近 TOB 理念——agent 自己知道什么没做好，自己决定怎么调整，而不是每轮从 JSON 重新建立心智模型。

对齐 TOB 技巧 #3: 攻击面拆分（zlib 五面 + 一个开放面）。

### 3. `goal-hunt` — 目标驱动漏洞发现

| 属性 | 值 |
|-------|-----|
| 角色 | scan |
| 并发 | 8 (fanOut per surface) |
| 容器 | **persistent: true**, reuseContainer |
| 每个 fanOut 项 | 一个攻击面 |

输入：goal spec + 当前攻击面。
输出：candidate finding **或** exhaustion declaration（此面已穷尽，无发现）。

关键设计：
- **persistent agent**：在一个 attack surface 上多轮迭代，上下文完整保留
- Agent 内部自主决策：换方法 / 深入追踪 / 声明耗尽
- Goal 文本中包含持久化语言："no bugs found 是中间状态，不是成功"
- 显式 stop condition：找到 **恰好一个** 达到标准的 finding，或证明此面无攻击路径
- 不同模型/参数可以注入不同的判断维度（Judge A vs Judge B）

对齐 TOB 技巧 #2 + #3: outcome-heavy prompt + one agent per surface.

### 4. `goal-judge` — 双独立并行判定

| 属性 | 值 |
|-------|-----|
| 角色 | verification |
| 并发 | fanOut 2 per candidate（并行两路） |
| 容器 | reuseContainer, 非 persistent |

两路并行：

| 支路 | 问题 | 角度 |
|-------|------|------|
| Judge A — 安全风险 | 这是真正的安全漏洞吗？ | 攻击路径有效性、影响范围 |
| Judge B — PoC 可行性 | 在威胁模型下能写出 PoC 吗？ | 可利用性、前提条件 |

两者都通过 → candidate 进入 dedup。
两者都驳回 → candidate 丢弃（此面/agent 产出 FP，不回头）。
分歧 → 标记 uncertain，仍进入 dedup 但附注分歧。

对齐 TOB: 双裁判 FP 过滤（不同模型/配置）。

### 5. `goal-dedup` — 重复检查

| 属性 | 值 |
|-------|-----|
| 角色 | verification |
| 并发 | 1 (serial) |
| 容器 | reuseContainer, 非持久 |

流程：
1. 搜索 GitHub issues / PRs / advisories
2. 交叉引用已有 scan findings
3. 已知 → 丢弃；新颖 → 进入 report

对齐 TOB: 人工过滤步骤自动化。

### 6. `goal-report` — 最终报告

| 属性 | 值 |
|-------|-----|
| 角色 | verification |
| 并发 | 1 (serial) |
| 非 AI | 是 |

输出：
- 有 finding：已验证的 novel finding + minimal safe proof + stop condition 证明
- 无 finding：clean-scan 报告 + 攻击面覆盖率证据

## 约束条件

1. 常规命令执行
2. 分支探索
3. 版本管理
4. 文件系统访问
5. 外部扫描工具（CodeQL, Semgrep 等）

## 路由/边

| 边 | 模式 | 说明 |
|----|------|------|
| `goal-craft` → `goal-surface` | map | goal spec 传下去 |
| `goal-surface` → `goal-hunt` | fanOut | 每个攻击面一个 agent |
| `goal-hunt` → `goal-judge` | map | candidate 进入双裁判 |
| `goal-judge` → `goal-dedup` | map | 通过或分歧的 candidate |
| `goal-judge` → `goal-hunt` | — | 不路由，驳回的 candidate 直接丢弃 |
| `goal-dedup` → `goal-report` | map | 新颖 finding |
| `goal-dedup` → `goal-hunt` | — | 不路由，重复的直接丢弃 |
| `goal-hunt` → `goal-surface` | map | **唯一 back edge**：所有面耗尽且零 finding。唤醒 `goal-surface` 的 persistent agent，由它反省上一轮策略并重新划面 |
| `goal-surface` → `goal-report` | map | 全局耗尽，无更多攻击面可探索 |

### Back edge 终止保证

`goal-surface` 是 persistent agent，跨轮维护完整上下文。每轮选择一个划分维度（模块/数据流/外部接口/依赖边界/…），已覆盖的代码区域自动去重。划分维度的空间有限——通常 2-4 轮后无法找到新的、与 goal 相关的角度，agent 声明全局耗尽。

## Agent Skills

| Stage | Skills |
|-------|--------|
| `goal-craft` | goal-craft |
| `goal-surface` | goal-surface |
| `goal-hunt` | goal-hunt, codeql, semgrep, tree-sitter |
| `goal-judge` | goal-judge |
| `goal-dedup` | goal-dedup, search-registries |
| `goal-report` | — (非 AI) |

## 与现有 Pipeline 的对比

| | full scan | research | **tob-goal** |
|---|---|---|---|
| 驱动方式 | 规则/模块驱动 | 范围/赛道驱动 | **目标驱动** |
| goal 定义 | 无（隐式） | 人类配置 scope | **Agent 自写 + 自红队** |
| 成功条件 | 每个目标扫完 | 链/primitive 完成 | **显式 stop condition** |
| 审核模型 | 串行 (critic → verify) | 串行 (validation → review) | **并行双裁判** |
| 拓扑 | DAG | DAG + 多 back edge | **DAG + 1 back edge** |
| agent 持久化 | 非持久 | 非持久 | **goal-surface + goal-hunt 持久** |
| 输出粒度 | 尽可能多 candidate | exploit chain | **恰好一个高质量 finding** |

---

## Stage 职责详解

### `goal-craft` — 把人类意图编译成可执行的 goal

**谁输入：** 人类研究员。

**职责：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **理解威胁方向** | 从人类输入中提取：目标仓库、关心的漏洞类型（RCE/权限提升/信息泄露/…）、攻击者模型（远程未认证/本地低权限/…）、可信边界（什么不算攻击面） |
| 2 | **编写 goal prompt** | 把威胁方向转化为具体、可测试的成功条件。包含：什么是"done"、什么证据算数、什么不算 valid finding |
| 3 | **自红队** | 站在"偷懒 agent"的角度，列出所有可能满足 goal 字面但没做真实工作的情况。例如："声称找到了但实际上只是 grep 了一个已知 CVE"、"在没有攻击路径的地方构造了一个理论场景" |
| 4 | **堵上后门** | 针对每个红队发现，修订 goal 的成功条件和驳回标准 |
| 5 | **注入持久化语言** | 在 goal 中编码："no bugs found 是中间状态，不是成功。如果当前方法没有产出，换方法/换角度/深入追踪，不要声明干净" |

**不做什么：**
- 不看代码库（那是 `goal-surface` 的事）
- 不定义用什么工具/方法
- 不被人类覆盖——如果人类输入本身有问题（范围太大/太窄），要主动指出并要求细化

**输出：** `GoalSpec` — 结构化 goal 文档，包含 success criteria、non-goals、attacker model、stop condition、persistence language。

---

### `goal-surface` — 以 goal 为透镜审视代码库

**谁输入：** `goal-craft`（首轮）或 `goal-hunt`（back edge，所有面耗尽后）。

**Persistent + multi-entry。** 同一个 agent session 跨多轮存活，接收反馈，调整策略。

**职责：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **阅读代码库结构** | 理解目录树、模块边界、依赖关系、外部接口 |
| 2 | **以 goal 为透镜找攻击面** | 不是通用的 attack-surface mapping，而是根据 goal spec 中定义的成功条件筛选相关区域。如果 goal 是"找 RCE"，就聚焦反序列化、命令注入、动态执行等路径；如果 goal 是"找权限绕过"，就聚焦 authz 检查、中间件链、session 管理 |
| 3 | **排序 + 解释** | 每个攻击面附带解释：为什么这个面与 goal 相关、预期风险路径类型、置信度 |
| 4 | **首轮划面** | 第一轮选择一个划分维度（模块/数据流/外部接口等），产出 2-8 个攻击面 |
| 5 | **接收反馈，反省调整** | Back edge 重入时（所有面耗尽无 finding），agent 在同一 session 中看到：上一轮选了哪些面、每个面用了什么方法、为什么没产出。Agent 反省划分策略——"按模块分没找到，可能因为我忽略了跨模块的数据流"，然后换维度重新划面 |
| 6 | **去重历史区域** | Agent 的持久化上下文中包含所有历史覆盖记录，自动避免重复分配同一代码区域 |
| 7 | **声明全局耗尽** | 多轮后无法找到任何未覆盖且与 goal 相关的攻击面时，输出 `exhausted: true`，pipeline 终止 |

**不做什么：**
- 不在攻击面上做实际漏洞发现（那是 `goal-hunt` 的事）
- 不修改 goal spec
- 不输出少于 2 个面（太少说明分析不到位），不超过 8 个面（太多失去优先级意义）
- 不重复分配已覆盖的代码区域

**每次进入的上下文：**

```
[R1] agent: "我按模块边界划分，找到 surf-A(src/auth/), surf-B(src/network/), surf-C(src/parser/)"
      → fanOut to hunt → 全部 exhausted 或 FP
      → back edge 唤醒

[R2] agent: "上一轮按模块分，surf-C 的解析器当时感觉还有没覆盖的角落，
      但每个 hunt agent 都说穷尽了。可能是模块边界本身的盲区——
      攻击路径往往是跨模块的。这一轮我按数据流分：
      input-flow(外部输入→内部处理), auth-flow(认证→授权), data-flow(DB→响应)"
      → fanOut to hunt → ...

[R3] agent: "两轮都没找到。input-flow 的 semgrep 规则覆盖很全，
      auth-flow 验证了没有 bypass。还剩一个角度——依赖边界：
      第三方库的版本和已知 CVE、与外部系统的集成点。
      这是前两轮都没深入看的。"
      → fanOut to hunt → ...

[R4] agent: exhausted: true
      "三轮覆盖了模块/数据流/依赖边界三个维度，所有与 goal 相关的区域都验证过了。
      基于当前代码库状态，没有更多攻击面可探索。"
```

**输出：** `SurfaceList` — N 个攻击面（每个附带 file paths、risk pathways、与 goal 的关联说明、本轮划分维度）或 `exhausted: true` 声明终结。

---

### `goal-hunt` — 在一个攻击面上追逐 goal

**谁输入：** `goal-surface`（每个面一个 instance）。

**这是整个 pipeline 的核心。** Persistent stage — 在一个固定攻击面上多轮迭代。

**职责：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **理解攻击面** | 深入阅读该攻击面对应的代码区域，建立攻击者视角的数据流模型 |
| 2 | **选择方法** | Agent 自主决定用什么手段：静态分析（CodeQL/Semgrep）、手动追踪（tree-sitter AST）、模糊测试（libafl）、沙箱验证。Goal 不规定方法——agent 选择能达成 goal 的方法 |
| 3 | **多轮迭代** | 如果一轮没有产出：换方法、扩大范围、深入调用链。persistent session 保留之前所有上下文——agent 知道自己试过什么，不会重复 |
| 4 | **产出 candidate** | 找到一个达到 goal 标准的候选漏洞，附上：触发路径、攻击前提、数据流证据、初步影响评估。Candidate 必须自洽——agent 内部 pre-filter，不能输出明显的误报 |
| 5 | **声明耗尽** | 如果穷尽了所有合理方法和路径仍然没有产出，声明此攻击面 `exhausted`。声明必须附带：试过的方法列表、覆盖的代码区域、为什么认为没有遗漏 |

**不做什么：**
- 不产出一个以上 candidate（对齐"one agent, one outcome"——找到一个就停，留给 pipeline 后续阶段处理）
- 不自己判定 candidate 是否为最终确认漏洞（那是 `goal-judge` 的事）
- 不跨攻击面——每个 instance 严格限定在自己的面内

**持久化行为：**
- 容器不销毁，跨 turn 保持文件系统和 agent 会话
- 每一轮 agent 收到上一轮的上下文和结果
- Agent 自己判断：继续 / 换方法 / 声明 done
- 外部 timeout 兜底——如果 agent 跑飞了，pipeline 级别的超时强制终止

**输出（二选一）：**
- `CandidateFinding` — 一个 candidate，含路径、证据、初步影响
- `ExhaustionDeclaration` — 此面耗尽，含方法覆盖记录

---

### `goal-judge` — 双裁判独立验证

**谁输入：** `goal-hunt`（每个 candidate 触发两个并行 judge）。

**职责（Judge A — 安全风险判定）：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **验证攻击路径** | 追踪 candidate 声称的触发路径，确认每一步在代码中真实存在且可被攻击者触发 |
| 2 | **排除非漏洞** | 识别以下情况：需要攻击者已经控制的前提条件、在正常使用中不可达的路径、防御机制（如 sandbox/capability drop）在 upstream 已阻止 |
| 3 | **评估影响** | 如果路径成立，攻击者能达到什么：RCE/信息泄露/DoS/权限提升？与 goal spec 定义的成功条件是否匹配？ |
| 4 | **给出判决** | `confirmed` / `rejected` / `needs-more-evidence`，附理由 |

**职责（Judge B — PoC 可行性判定）：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **评估可利用性** | 在 goal spec 定义的威胁模型下，攻击前提是否满足？攻击者模型（远程/本地/需认证）与 candidate 的前提是否一致？ |
| 2 | **构造最小 PoC 轮廓** | 不要求完整 exploit，但必须明确到"一个攻击者可以写出的 PoC 需要什么步骤和条件" |
| 3 | **挑战假设** | Candidate 是否隐含未声明的假设（比如"攻击者能控制这个 header"但实际上中间件在前面就 strip 了）？ |
| 4 | **给出判决** | `poc-viable` / `poc-infeasible` / `poc-uncertain`，附理由 |

**合并规则：**

| Judge A | Judge B | 结果 |
|---------|---------|------|
| confirmed | poc-viable | ✅ 通过，进入 dedup |
| confirmed | poc-infeasible | ⚠️ 分歧，标记 uncertain，仍进入 dedup |
| rejected | — | ❌ 丢弃 candidate |
| needs-more-evidence | — | ⚠️ 分歧，进入 dedup 标注 insufficient |
| — | poc-viable 但 A rejected | ❌ 丢弃（安全风险不成立，PoC 无意义） |

**不做什么：**
- 两个 judge 不互相通信或知道对方的判决（保持真正独立）
- 不修改 candidate 内容（只判定，不修补）
- 不推荐"怎么修"（只判定是不是漏洞）

**输出：** `JudgeVerdict` — 双路判决 + 理由 + 合并结果。

---

### `goal-dedup` — 新颖性检查

**谁输入：** `goal-judge`（通过或分歧的 candidate）。

**职责：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **搜索已知漏洞** | 在 GitHub issues/PRs、安全 advisories（GHSA/CVE/NVD）、项目 changelog 中搜索与 candidate 匹配的已知问题 |
| 2 | **交叉引用已有 findings** | 检查本次 scan 或历史 scan 是否已经报告过同一漏洞 |
| 3 | **判定新颖性** | `novel` / `known-duplicate` / `known-fixed`，附引用来源链接 |
| 4 | **非重复性判断** | 如果已知问题是同一类但不是同一个实例（variant vs duplicate），标记为 novel 但注明已知同类 |

**不做什么：**
- 不判定这是否是漏洞（那是 `goal-judge` 的事）
- 不评估严重性/优先级（那是 `goal-report` 的事）

**输出：** `DedupResult` — `novel` → 进入 report；`duplicate` / `fixed` → 丢弃并记录来源。

---

### `goal-report` — 最终编译

**谁输入：** `goal-dedup`（新颖 candidate）或 `goal-surface`（全局耗尽）。

**非 AI stage。**

**职责：**

| # | 职责 | 说明 |
|---|------|------|
| 1 | **编译 finding 报告** | 将 candidate + judge verdict + dedup result 编译成结构化报告 |
| 2 | **附带 minimal safe proof** | 攻击路径摘要、关键证据（代码片段、数据流）、PoC 轮廓 |
| 3 | **证明 stop condition 满足** | 说明这个 finding 为什么满足 goal spec 中定义的成功条件 |
| 4 | **clean-scan 报告** | 如果没有 finding，列出所有覆盖的攻击面、每个面尝试的方法、覆盖率证据 |
| 5 | **人类可读输出** | 报告格式适合人类 review 后决定是否向上游提交 |

**不做什么：**
- 不重新评估 finding 质量
- 不上报给上游（那是人类的事）

**输出：** 最终报告文件，写入 scan job 的 output 目录。

---

## 待定

- [ ] `goal-craft` 的输入 schema — 人类怎么描述"关心什么"
- [ ] `goal-surface` 的输出 schema — 攻击面粒度
- [ ] goal-hunt 的 persistent session timeout 策略
- [ ] 两个 judge 是否需要不同的模型/参数
- [ ] goal-report 的 clean-scan 证据格式
