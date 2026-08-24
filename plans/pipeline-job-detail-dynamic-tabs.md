# Pipeline 驱动的 Job 详情动态标签

## Summary

将 Job 详情页的业务结果标签从前端硬编码改为由 Pipeline Definition 配置。Overview、Tasks、Monitoring、Files 保持固定；Findings、Tracks、Primitives、Chains、Goal Candidates、Goal Findings 等结果页由 Pipeline 的 `presentation.jobTabs` 决定。

Pipeline 编译时校验并固化标签配置，创建 Job 时将其写入 Job snapshot。Job 页面只读取 snapshot，不再根据 `pipelineKind` 推断业务标签。

## Pipeline Definition

在 V3 YAML 增加：

```yaml
presentation:
  jobTabs:
    - id: findings
      label: Findings
      renderer: entity-table
      dataSource: research-findings
      columns:
        - title
        - trackKey
        - vulnerabilityClass
        - location
        - status
        - confidence
        - updatedAt
      filters:
        - status
      defaultSort:
        field: updatedAt
        direction: desc
      detail: research-finding
```

约束：

- `id` 必须唯一，且不能覆盖 `overview`、`tasks`、`monitoring`、`files`。
- `renderer`、`dataSource`、字段、过滤器和排序字段只能使用注册表中的枚举值。
- Pipeline 编译阶段校验 renderer 与 dataSource 的兼容性。
- 不允许 YAML 直接指定 SQL、表名、React 组件路径或任意查询参数。
- 标签顺序按 YAML 顺序保存，并显示在 Tasks 与 Monitoring 之间。

内置 Pipeline 增加明确配置：

- Full/Delta：`Candidates`
- Research：`Findings`、`Tracks`、`Primitives`、`Chains`
- ToB Goal：`Goal Candidates`、`Goal Findings`
- Orchestrator/Hunt：按实际结果实体配置，不再通过 pipeline name 映射。

## 后端数据层

新增统一的 Job Tab Data Source Registry，每个数据源声明：

- 数据源 ID 和可用 renderer。
- 可展示字段、可排序字段、枚举过滤字段。
- 列表查询、详情查询和分页能力。
- 统一返回 `items`、`total`、`page`、`pageSize`、`filterOptions`。

首批注册：

- `vulnerability-candidates`
- `research-findings`
- `research-tracks`
- `exploit-primitives`
- `exploit-chains`
- `tob-goal-candidates`
- `tob-goal-findings`

新增统一接口：

```text
scan.jobTabData
scan.jobTabDetail
```

接口根据 `scanJobId + tabId` 读取 Job snapshot，校验授权、字段、过滤器和排序参数，再调用对应 Data Source Adapter。删除前端依赖 `pipelineKind` 的结果页选择逻辑，以及不再需要的硬编码标签接口；底层 repository 可继续复用。

历史 Pipeline 执行一次回填，将当前硬编码映射转换为 `presentation.jobTabs`，并为历史 Job 写入对应的 compiled presentation snapshot。回填完成后删除 `CompiledPipelineCapabilities`、`derivePipelineCapabilities()`、`resolveScanJobPipelineKind()` 及相关兼容分支。

## 前端与编辑器

在 Pipeline Definition 编辑器新增 `Presentation` 区域，支持：

- 添加、删除和拖拽排序 Job Tab。
- 配置 tab ID、标题、renderer、data source。
- 选择列、枚举过滤器、默认排序和详情 renderer。
- 显示数据源支持的字段与过滤器选项。
- 校验重复 ID、保留 ID、无效字段和 renderer/dataSource 组合。

Job 详情页改为：

- 固定渲染核心标签。
- 根据 Job snapshot 动态生成业务标签。
- 使用 `DynamicJobTabRenderer` 按 renderer 注册表加载组件。
- `entity-table` 提供搜索、枚举过滤、排序、分页和右侧详情面板。
- 保留现有 Candidate 专用展示能力，并将其封装为 `candidate-results` renderer。
- 未知或已删除的 tab 自动回到 Overview，并显示明确提示。
- 将 Candidate 查询状态从全局 Job Context 移入对应 renderer，避免无关标签触发查询。

删除 `research-registry-tabs.tsx` 以及结果页中基于 research/tob-goal 分支的硬编码 tab 和重定向逻辑。

## 测试与验收

- Pipeline schema、编译器和 diagnostics：presentation 缺失、重复 ID、保留 ID、未知字段和非法数据源均被拒绝；所有内置 Pipeline 生成正确标签配置；回填前后标签数量和顺序一致。
- 后端：Job snapshot 正确保存 presentation；统一列表/详情接口验证组织权限、Job 权限、字段、过滤器、排序和分页；不同数据源返回结构一致，空数据和未知 tab 可诊断。
- 前端：Full、Research、ToB Goal、Orchestrator 页面显示各自配置的标签；搜索、过滤、排序、分页、详情抽屉和刷新保持正确；不同标签切换不触发无关数据查询。
- Browser 验收：打开不同 Pipeline 创建的 Job，确认标签、URL、面包屑和内容一致；修改 Presentation 后保存 Draft、刷新页面、重新打开 Job，确认配置持久化；检查控制台无 React 错误，所有数据请求成功。
- 执行 `pnpm --filter vulseek test`、`pnpm --filter @vulseek/server typecheck`、`pnpm --filter vulseek typecheck` 和 `git diff --check`。

## Assumptions

- 只做一次历史 Pipeline/Job presentation 回填，不保留运行时 `pipelineKind` fallback。
- Job 详情页的核心标签始终固定，业务结果标签完全由 Pipeline 配置。
- Job 使用创建时的 compiled snapshot；后续修改 Pipeline 不改变已经创建的 Job。
- 不新增业务实体表或数据库字段；仅复用现有 repository 和 Job snapshot。
