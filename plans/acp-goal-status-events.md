# ACP Goal Status Events

## Summary

升级 ACP SDK 及 Codex、Claude Code Adapter，并接入两个 Adapter 通过 `session/update` 发布的 Goal v1 状态。Vulseek Driver 将真实 Goal 更新转换为当前 Task 的普通 activity，Task/Job activity SSE 沿用现有 `activity` 事件返回该更新。

Task 仍以 `session/prompt` 的 `end_turn` 完成。Goal 状态不替代 Task 生命周期，不新增数据库字段、独立 Goal SSE 事件或前端展示。

## Dependency And Adapter Updates

- `@agentclientprotocol/sdk`: `1.2.1` -> `1.3.0`。
- `@agentclientprotocol/codex-acp`: `1.1.2` -> `1.3.0`。
- `@agentclientprotocol/claude-agent-acp`: `0.59.0` -> `0.68.0`。
- 更新 workspace lockfile、scan-tools Dockerfile、tools image 版本断言和构建输入。
- Claude Adapter 要求 Node.js 22 以上，scan-tools 构建时显式校验 Node 版本。
- 将现有 Codex `session/fork` patch 移植到 `codex-acp@1.3.0`，继续提供 `thread/fork`、ACP `session/fork` handler 和 `sessionCapabilities.fork`。
- Goal 使用 Adapter 已实现的 ACP `_meta` 扩展，不修改或 fork ACP SDK schema。

## Goal Event Contract

两个 Adapter 的输入格式统一为：

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "goal": {
      "objective": "Audit the selected attack surface",
      "status": "active",
      "controlMethod": "_session/goal"
    }
  }
}
```

规范化 Goal 状态为 `active | paused | blocked | limited | complete`，并保留 Adapter 提供的 `iterations`、`lastReason`、时间、token budget 和 usage 字段。`_meta.goal: null` 表示 Goal 已清除；不包含 `goal` 的 `session_info_update` 不产生 Goal 事件。

Driver 收到真实更新时向当前 Task stdout 追加普通 activity：

```json
{
  "type": "activity",
  "taskId": "task-id",
  "sessionId": "session-id",
  "status": "running",
  "activity": {
    "kind": "goal",
    "label": "Goal active",
    "detail": "Audit the selected attack surface",
    "goal": {
      "objective": "Audit the selected attack surface",
      "status": "active",
      "controlMethod": "_session/goal"
    }
  }
}
```

`AgentActivityKind` 增加 `goal`，`AgentActivity` 增加可选的 `goal: AgentGoalSnapshot | null`。Goal clear 生成 `kind: "goal"`、`label: "Goal cleared"`、`goal: null`。其他状态的 label 分别为 `Goal active`、`Goal paused`、`Goal blocked`、`Goal limited` 和 `Goal complete`；`detail` 使用 objective。

Persistent Driver 可以在进程内维护 `currentGoal`，但切换 Task 时不得向新 Task stdout 重放或合成 Goal activity，也不得重新发送 `/goal`。新 Task 在收到下一条真实 Goal 更新前不会产生 Goal activity。

Stage 的现有 `goal: true` 传递为 Driver `goalEnabled`。Goal Task 初始化时要求 Adapter 声明 Goal v1 capability；缺失时明确失败。普通 Task 不受影响。

## Activity SSE

- Driver stdout parser 和增量 tail reader继续使用 `latestActivity`，不增加 `latestGoal`。
- Task activity SSE 的 `snapshot` 和 `activity` payload 结构保持不变；Goal 更新通过 `activity.kind: "goal"` 表达。
- Job activities SSE 的每个 Task payload 结构保持不变。
- 每个真实 Goal 更新必须形成一条可观察的 activity revision，并通过现有 `event: activity` 推送；不得因同一轮随后到达的 thinking/tool activity 而漏发 Goal activity。
- 不新增 `event: goal`，也不增加与 `activity` 并列的 `goal` 字段。
- Native transcript `agent-stream`、前端 activity hook 和数据库保持不变。

## Tests

- Normalizer 覆盖 Codex、Claude Goal 状态、Claude 特有字段、clear、非法 Goal 和无关 session info。
- Driver 覆盖 capability 校验、Goal activity 写入、各状态 label、其他 session 隔离、persistent Task 不重放，以及 Goal active 时 `end_turn` 仍完成 Task。
- stdout parser/tail reader覆盖 append、半行、truncate、文件替换和 `Goal cleared` activity。
- Task/Job SSE 覆盖初始 snapshot、Goal activity revision、Goal 与后续 thinking/tool 在同一 polling window 内均不丢失，以及 payload 中不存在并列 `goal` 字段。
- 验证 Codex fork patch 在 `1.3.0` 上可应用，初始化同时声明 Goal 和 fork capability。
- 重建 dev scan-tools image，分别使用 Codex 和 Claude 验证 `/goal`、`session/update`、stdout 和 activity SSE；不操作 release。

```bash
pnpm --dir vendor/claude-replay test
node --test packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

## Assumptions

- Goal 继续由现有 `/goal` prompt 设置，本次不新增 set、pause、resume 或 clear API。
- 不兼容旧 Adapter 的私有 Goal 格式，只处理新版统一的 `_meta.goal`。
- Driver 进程内的 `currentGoal` 不作为 durable storage；Driver 重启后等待 Adapter 发布新的真实状态。
- 保留当前工作区中的 ToB Goal 改动，并在重叠文件中增量实现。
