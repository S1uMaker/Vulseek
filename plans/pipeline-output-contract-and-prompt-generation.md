# Pipeline Output Contract and Prompt Generation

## Summary

将 `/task/output.schema.json` 设为 Stage 结构化输出协议的唯一来源。Runtime 不再把完整 output schema 或 artifact schema JSON 内联到 Prompt；Stage Definition 的 Prompt 只描述业务任务，文件写入、envelope、route、exit 和校验要求统一自动生成。

`route.description` 为可选字段。历史 Pipeline 版本和历史 Job 不做迁移、fallback 或兼容处理；新实现只保证更新后的 Pipeline Definition 和新建 Job 正常运行。

## Output Contract

- Runtime 为每个 Task 生成 `/task/output.schema.json`，其中包含完整 `{ route, exit, output }` envelope schema。
- 为 `route`、`exit` 和 `output` 写入标准 JSON Schema `description`；保留 output schema 中所有层级的字段 description，包括 `$ref` 展开和 `$pathOf` 转换后的路径字段。
- 使用 Draft-07 `definitions` 保存 artifact 文件内容 schema，并通过 `x-vulseek-artifacts` 记录 output 字段路径、单文件/文件列表类型和对应 schema ref。
- 使用 `x-vulseek-routes` 保存去重后的 route 元数据，仅包含：
  ```json
  {
    "key": "confirmed",
    "description": "Use when independent review confirms the result.",
    "default": false
  }
  ```
- `description` 为空或仅含空白时省略，不根据 Edge 名称或下游 Stage 自动生成 description。`x-vulseek-routes` 不包含 destinations。
- routed Stage 继续通过 envelope schema 中的 route `const` 和 route-specific output schema约束合法组合；非 routed Stage 强制 `route: null`。
- `allowAgentExit=false` 时 schema 强制 `exit: false`。允许 Agent exit 时，`exit` 仍只表示退出 persistent lane/group，不代表失败，也不替代 route 或阻止下游派发。

- 在 `agents/skills/output-validator/` 提供统一 Skill，包含 `SKILL.md` 和 `validate_output.py`。runtime 将该 Skill 作为默认 Skill 安装到每个 Agent Home；每个 Task 不生成或复制独立 Validator，只生成自己的 schema。
- 自动 Prompt 要求 Agent 先读取 `$VULSEEK_AGENT_HOME/skills/output-validator/SKILL.md`，再执行：
  ```bash
  python "$VULSEEK_AGENT_HOME/skills/output-validator/validate_output.py" \
    --schema /task/output.schema.json \
    --output /task/output.json
  ```
- Validator 使用 `jsonschema` 校验 envelope，并根据 `x-vulseek-artifacts` 打开和校验所有关联 artifact；失败返回非零状态和简短定位信息。
- Runtime 自动追加简短 Output Protocol：先读取 schema 文件、解释 envelope 三个字段、列出 route key/可选 description/default、要求写文件并校验通过后再结束 turn。
- Prompt 中不出现完整 schema、JSON fenced block或 artifact schema JSON。删除 native `/goal` 对手写 structured-output 章节的特殊绕过，所有 Agent/Goal Stage 使用同一生成逻辑。
- Pipeline 完成处理继续执行服务端 schema、artifact 和 route 校验，Agent 本地校验不能替代后端校验。

## Pipeline Definition Changes

- Edge route 调整为：
  ```yaml
  route:
    key: confirmed
    description: Use when the current result is independently confirmed.
    default: false
  ```
- `description` 可选；编辑器清空或只输入空白时删除该字段。
- 删除 V3、legacy converter、runtime 类型和编辑器中的 `outputSchemaDescription`。需要描述 output 结构时，使用 output schema 自身的标准 `description`。
- 同一 Stage 下相同 route key 的 Edge 在 Runtime 中合并为一个 route 选项。多个非空 description 不一致时阻止发布；缺失 description 是合法状态。
- 更新 Edge Route 编辑器和 Raw YAML/Form 同步逻辑；同 route key 的 description/default 编辑应同步到对应 Edge，避免 fan-out route 元数据分叉。
- 不保留旧字段解析、旧 compiled definition fallback 或历史 snapshot 修复逻辑。旧版本因此无法重新解析或运行属于明确接受的行为。

## Built-in Prompt Cleanup

- 清理 Full、Delta、Research 和 ToB Goal 的 V3 YAML，以及对应 legacy Markdown prompt。
- 删除所有手写 `/task/output.json` 示例、`output.schema.json` 校验步骤、envelope 说明、route mapping、`set route` 和 `set exit` 指令。
- 将 route 选择条件迁移到对应 `route.description`；description 确实没有补充价值时允许省略。
- 将删除段落中仍有业务意义的字段规则迁移到 schema 的 `description`、`required`、`enum/const` 或 route-specific schema。
- 保留分析方法、证据要求、数据库操作、业务 artifact 生成和其他 Stage 职责说明。
- 增加内置模板检查，禁止重新加入保留输出协议文本，但不禁止 Prompt 描述普通业务文件。

## Tests

- 验证生成 Prompt 不包含内联 output/artifact schema，只包含一次自动 Output Protocol 和 Validator 命令。
- 验证普通、嵌套、`$ref`、`$pathOf` 字段 description 均写入 schema；空 route description 被省略。
- 验证 `x-vulseek-routes` 只包含 key、可选 description 和 default，相同 key 只出现一次且不包含 destinations。
- 验证 Validator 对合法输出、非法 route、错误 envelope、缺失/非法 artifact、artifact 列表和嵌套 artifact 的处理。
- 验证非 routed Stage 的 `route:null`、禁止 exit 的 `exit:false`，以及 route-specific output 校验。
- 验证同 key 的冲突 description 阻止发布，description 全部缺失时仍可发布。
- 验证四个更新后的系统 Pipeline 均可解析、编译和发布，且 Prompt 不再包含手写输出协议。
- 使用 agent-browser 验证 Edge Route 编辑器、Description 清空、Raw YAML 同步、发布诊断和新版本只读视图。
- 执行 `pnpm --filter vulseek test`、server/frontend typecheck、tools image Validator 测试和 `git diff --check`。

## Assumptions

- 不修改 `exit` 的现有 lane/group 语义。
- 不新增数据库字段或 migration，不修复历史 Pipeline/Job snapshot。
- Validator 通过现有 runtime skill 复制机制进入容器，不要求重建 tools image；实际运行验证先只使用 dev。
- 系统 Pipeline 通过现有模板同步机制生成新版本，不覆盖旧版本记录。
