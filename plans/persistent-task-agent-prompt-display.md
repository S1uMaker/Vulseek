# Persistent Session 与 Agent Prompt 展示计划

## Summary

本次只调整 Session/AgentStream 的会话记录和展示：

- 每次实际发送给 ACP `session/prompt` 的最终 prompt 都记录并显示在 claude-replay 风格的 Session/Agent Stream 中。
- Persistent session 的多轮 prompt 按真实 Task 顺序合并展示。
- 保留每轮 Task 的完成、output、route 和下游 dispatch 语义，不把已完成的单轮 Task 长期伪装成数据库 `running` 状态。
- 不修改 Job Activities、Task Activity 或 Running Tasks 使用的 activity SSE、payload、轮询和接口。

## Implementation Changes

### Prompt 记录

- ACP driver 在每次真正调用 `session/prompt` 前记录最终发送文本，而不是 YAML 原始模板。
- 记录内容包含模板渲染、input、goal prompt、output protocol、schema、route/exit 说明、skill/policy 注入，以及 structured-output recovery prompt。
- 直接复用每个 Task 已有的 `stdout` JSONL，不新增 `prompts.jsonl` 或其他 prompt 文件；在发送 ACP 请求前追加标准化 `prompt` 事件：

  ```json
  {
    "type": "vulseek_prompt",
    "promptId": "...",
    "taskId": "...",
    "sessionId": "...",
    "turnIndex": 1,
    "timestamp": "...",
    "text": "最终发送给 ACP 的完整 prompt"
  }
  ```

- 普通 Task 的 prompt 写入当前 Task 的 `stdout`；Persistent session 的每一轮 prompt 写入对应 Task 的 `stdout`，服务端按 lane 的 Task 顺序合并展示。
- Prompt 原文沿用现有 transcript 的访问权限和脱敏策略；旧 Task 缺少该文件时不报错。

### Session SSE 与 AgentStream

- `AgentStreamEvent` 增加 `prompt` 事件：

  ```ts
  {
    type: "prompt";
    payload: {
      promptId: string;
      taskId: string;
      turnIndex: number;
      text: string;
      timestamp: string;
      offset: number;
    };
  }
  ```

- 仅修改任务 Session 使用的 `agent-stream` SSE：同时读取原生 Codex/Claude transcript 与 Task `stdout` 中的 `prompt` 事件，支持历史快照、追加、半行、截断和文件重建。
- Session 侧复用或扩展增量 stdout reader 解析 prompt 事件，不把 activity、usage、error 等其他 driver 事件当作会话消息。
- React `AgentStream` 将 prompt 作为 USER turn 显示，默认折叠，支持长文本内部滚动，并与 thinking、tool call、tool result 保持现有顺序。
- 使用 `turnIndex` 和 `promptId` 合并 prompt 与原生 transcript：原生 transcript 已包含相同 user prompt 时去重，否则由 driver prompt 补齐。
- Task Session 和 Event/Agent Output 模态框统一使用该数据流；Running Tasks 仍使用现有 activity SSE，不接入该 prompt 数据流。
- 不改变 claude-replay CLI、静态导出和现有原生 transcript parser 的兼容行为。

### Activity SSE 边界

- 不修改 Job Activities SSE、Task Activity SSE 及其前端 hooks。
- 不向 activity payload 增加 prompt，不改变 activity 的读取、缓存、轮询、事件类型或刷新周期。
- Prompt 只通过 Session/AgentStream 路径读取和展示；stdout 中已有的 activity、usage、error 事件继续由原有 activity 逻辑处理。

## Test Plan

- Prompt 记录：最终渲染 prompt、goal continuation、普通 prompt 和 recovery prompt 均写入；并发追加、半行、截断和重建可恢复。
- AgentStream：snapshot/append prompt 事件、USER 默认折叠、与 thinking/tool result 合并、原生 user message 去重、persistent 多轮顺序。
- Browser：启动 persistent Research/ToB Goal Job，打开 Event 模态框和 Session 标签页确认完整最终 prompt；完成多轮后确认 prompt 顺序、折叠和增量更新；退出或取消后确认 Session 状态正确。
- Regression：确认 Job Activities、Task Activity 和 Running Tasks 的现有 SSE 请求、payload 与展示行为未改变。
- 验证命令：
  ```bash
  pnpm --filter vulseek test
  pnpm --filter @vulseek/server typecheck
  pnpm --filter vulseek typecheck
  git diff --check
  ```

## Assumptions

- 本次不实现 Persistent lane 在 Running Tasks 中的额外 projection；只处理其 Session 的 prompt 记录和展示。
- 不新增数据库表或 migration，复用现有 Task 的 stdout、stage/container 信息和原生 transcript。
- Prompt 以最终发送给 ACP 的完整文本为准。
- Activity SSE 的数据源和接口保持不变。
- 开发和验证只操作 dev，不连接、修改或重启 release 环境。
