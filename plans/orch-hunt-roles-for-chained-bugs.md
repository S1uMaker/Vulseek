# orch-hunt：Orchestrator 与 Hunter 职责（以链式洞为目标）

现有 `orch-hunt` 拓扑不变：一个 persistent Orchestrator 派多个 Hunter，Hunter 只回 `name` + `feedback`，完整 candidate 由 Orch `submit_candidate`，再进 verify / triage。

本文固定 **Orch 管切面、记账、拼链；Hunter 管把一个 primitive 钉死**。动机是 wp2shell 这类洞（CVE-2026-63030 REST batch 错位 + CVE-2026-60137 `author__not_in` SQLi → 未认证 RCE）：单个 primitive 都不是 RCE，必须组合。

不写 PoC。Candidate 只交 entry → primitive(s) → sink → 影响 的 `file:line` 与证据。

## 为什么现在的分工会漏掉链式洞

| 现在 | 链式洞需要 |
|------|------------|
| Hunter「直到有一个完整 candidate / 一条 end-to-end 路径」 | Hunter 交 **primitive + blocker**，完整链由 Orch 组 |
| 8 路 `goalPrompt` 都是「未认证远程 RCE」 | 第一波拆 primitive，第二波打「缺口」（例如字符串如何绕过 REST schema 进入 `WP_Query`） |
| 反馈是一段自由文本 `feedback` | 至少稳定包含：primitive 类型、file:line、还缺哪个 primitive |
| Orch 只把「完整漏洞」当成功 | 「sink 在、入口被挡」是资产，要开 connector hunt，不是结案 |

wp2shell 的 primitive：

1. Sink：`author__not_in` 字符串不 `absint`，可拼进 SQL（兄弟 `author__in` 是安全的）。
2. 挡板：REST `author_exclude` 声明成 int array，正常请求进不去。
3. 走私：batch 里 `WP_Error` 不进 `$matches`，handler 按下标错一位。
4. 升级：注入能读/伪造行之后，再接到权限/写文件，才是 RCE。

6.8 只有 1 没有 3。Orch 若只收完整 RCE，Hunter 若只交「能打的洞」，1 和 3 都会当失败丢掉。

## Orchestrator

一人、持久 Goal、`inputDelivery: poll`。是研究主管，不是第三个 Hunter，不要自己跟单个 sink 文件死磕。

1. **按 primitive 切面派 hunt，不按「找一个 RCE」切面。** 第一波并行例如：未认证 REST 能碰到的 `WP_Query` 变量卫生；REST batch / 请求匹配 / error 是否仍对齐 handler；查询结果若被当对象用（类型、capability、oEmbed/customizer）会不会变成写权限。这些是 primitive，不是 finished finding。
2. **把 Hunter 的「打不满」当成资产。** 反馈若是「sink 在、REST 把字符串挡掉了」，开 **connector hunt**：有没有路径让 query var 绕过 schema 仍进 `WP_Query`（batch、内部 `serve_request`、插件）。
3. **拼链再 `submit_candidate`。** Candidate 必须是 entry → 走私/连接 → sink → 影响，每个 primitive 都有 `file:line`。单独的 SQLi 或单独的 batch 错位都不够当「未认证 RCE」。
4. **覆盖账本记 primitive，不记「这个子系统没洞」。** 例如已确认某 query var 缺 sanitizer、batch `$matches` 会短。后续 hunt 补缺口，不重扫同一 REST 面。
5. **目标仍是高 CVSS，允许中间态。** 现有 prompt「一个 bug 不够就组合 primitive」要落到 spawn 策略上，而不是 8 路同时写「找未认证 RCE」。
6. **只通过 `orchestrator.py` 派猎、收反馈、交 candidate。** 不写 exploit。动态验证整条利用链不是 Orch 的活；需要跑实例时由后续 stage / `runtime-analysis` 在锁内做单个 primitive 确认。

模型：Orch 适合相对强的模型（读反馈、发现「挡板 + sink」结构）。

## Hunter

一路 Goal、一个 `goalPrompt`、回一条 feedback。是 **一个 primitive 的深挖**，不是迷你 Orch。

1. **目标写成可证伪的一个 primitive**，例如「哪些 `query_vars` 进 SQL 时没 `absint`/`prepare`，REST 是否把它收成 array」；「batch 子请求失败时 `$requests` 与 `$matches` 是否按下标对齐」。不要写「在 REST 里找到 RCE」。
2. **反馈必须带缺口。** 有 sink 但入口被 schema 挡死：挡在哪、还差什么才能喂进字符串。这是给 Orch 派下一个 primitive 用的，不是「没挖到」。
3. **方法要换，围着同一个 primitive。** 对比兄弟 API、看相关重构、CodeQL/Semgrep 找 raw interpolation。不要第一轮 grep 没 RCE 就收工。
4. **动态验证只证明自己那一个 primitive**（若挂了 `runtime-analysis`）。不要每个 hunter 都走完整「建管理员 / 写文件」链——那会把共享 Web 实例写脏，且越过 Orch 拼链。
5. **不交 exploit，不 `submit_candidate`。** 交数据流和证据。`name` 必须原样回 Orch 分配的 `#n slug`。
6. **不声明 exhaustion。** 切不动了就在 feedback 里写清 blocker，让 Orch 决定是否另开 primitive。

模型：Hunter 可用较便宜的模型，但 prompt 必须把 primitive 收窄，否则会短跑后交空。

## 反馈契约（给 Orch 能拼链）

Hunter `feedback` 至少能让 Orch 抽出：

- primitive 类型：sink / 挡板 / 走私或错位 / 权限升级
- `file:line`（及符号）
- 已证实什么
- **还缺哪个 primitive** 才能接到未认证入口或接到影响
- 建议的下一个 primitive（可选，Orch 可改）

Orch 的 `/lane` ledger 按 primitive id 记账（不是按文件名去重），并记录哪些 primitive 已组合进已提交的 candidate。

## 和 verify / triage / runtime-analysis

- **verify**：只核对 candidate 上已声称的路径和事实，不负责发现新 primitive。
- **triage**：在事实成立后判影响 / 利用性 / 是否安全问题。
- **runtime-analysis**（若落地）：Hunter 用来确认 **本 primitive**；Web 全程走 Python 锁，禁止并行 hunter 各起一套或无锁写库。整链动态验证放在 Orch 已提交 candidate 之后，不要 8 路同时打同一实例做完整利用。

## 明确不做什么

- 不把整条 RCE 塞进单次 hunt 的 `goalPrompt`。
- 不把「没找到完整 RCE」写成 Hunter 成功结束条件。
- Orch 不替代 Hunter 读大段实现；Hunter 不替代 Orch 决定下一个 primitive 和是否提交 candidate。
