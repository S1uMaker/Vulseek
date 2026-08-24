# Vulseek 核心功能概览

本文档面向产品介绍和 PPT 制作，围绕三个主要模块梳理 Vulseek 当前支持的核心能力：流水线编辑与管理、项目管理与扫描、数据集配置与评估。

## 1. 流水线编辑与管理

流水线是组织级别共享的扫描流程定义。系统使用 YAML 保存流水线配置，并将其编译为有向图：节点代表扫描阶段（Stage），边代表阶段之间的数据传递、条件路由和下游任务创建。流水线可以复用在多个项目和数据集评估中。

### 关键功能

- **流水线创建**：从空白配置或内置模板创建新的流水线，设置名称、标识、描述、支持的目标类型和根阶段。
- **YAML 配置**：以 Pipeline YAML 作为可持久化、可审查、可版本化的配置来源，支持原始 YAML 编辑和格式校验。
- **结构化 Definition 编辑**：按 Pipeline、Stage、Edge、Schema、Group 和 Layout 分栏编辑，减少直接维护大型 YAML 的成本。
- **Visual 图形编辑**：通过 React Flow 画布查看拓扑关系，新增 Stage、创建 Edge、调整节点位置、自动布局、缩放和 MiniMap 导航。
- **Stage 配置**：配置阶段名称、职责、提示词、工作目录、Agent Profile、输入输出 Schema、输入文件、Skills、Plugins、运行模式、容器复用、持久会话和 Job Output 发布等运行参数。
- **Edge 配置**：定义来源和目标阶段、传递模式、输入映射、条件 Route、Route 描述、Artifact 生成以及下游任务输入。
- **Schema 管理**：为结构化 Agent 输出定义 JSON Schema，支持字段类型、必填项、枚举、嵌套结构和可选字段描述，并将 Schema 关联到 Stage 或 Edge。
- **诊断与校验**：实时显示 YAML 解析错误、未引用 Schema、无效 Stage/Edge 引用、路由和输入输出契约问题，并支持从诊断项跳转到对应实体。
- **版本与发布**：支持 Draft 编辑、保存、撤销/重做、版本查看、发布和归档；发布后形成可供项目扫描和评估使用的稳定版本。
- **Runtime Profile**：为同一条流水线保存不同的模型、Agent Profile、并发度和禁用阶段组合，运行时可选择对应 Profile。

### 适合 PPT 强调的价值

> 用 YAML 保证可审计和可复现，用结构化表单降低配置门槛，用可视化画布直观表达复杂扫描拓扑，并通过版本和诊断机制保证配置质量。

### 典型使用流程

```text
创建流水线 → 配置 Stage / Edge / Schema → Definition 或 Visual 校验
→ 保存 Draft → 查看诊断 → 发布版本 → 配置 Runtime Profile → 用于扫描或评估
```

## 2. 项目管理与扫描

项目模块面向实际代码仓库和应用目标。用户可以创建项目、配置代码来源和扫描上下文，选择流水线及运行 Profile 发起扫描，并在 Job 详情页持续查看任务执行、Agent 会话和扫描产物。

### 关键功能

- **项目管理**：创建、编辑和删除项目，统一管理项目下的应用、Compose 或代码仓库扫描目标。
- **扫描目标配置**：维护仓库地址、分支或提交、项目 Profile、代码 checkout 环境和扫描上下文路径。
- **流水线选择**：发起扫描时选择已发布的 Pipeline、版本和 Runtime Profile；将流水线拓扑与本次 Job 的运行设置固化为快照，保证运行过程可复现。
- **多种扫描模式**：支持 Full Scan、Delta Scan，以及面向研究和目标驱动分析的 Research / ToB Goal 等 Pipeline 模式。
- **阶段化扫描流程**：根据流水线依次或条件执行 Repository Profile、Attack Surface Model、Identify Target、Scan Target、Analyze Finding、Critique Finding、Verify Finding、Triage Finding 等阶段。
- **Job 生命周期管理**：查看 Pending、Running、Paused、Finalizing、Finished、Partially Finished、Failed 和 Canceled 等状态；支持暂停、恢复、取消、失败任务重试和单任务 Rerun。
- **任务队列与进度**：按 Stage 查看 Pending、Running、Finished 和 Failed Tasks，支持搜索、阶段筛选、状态筛选、分页和任务重跑。
- **Agent 会话查看**：在 Task 详情页查看原生 Agent Session、Prompt、Thinking、Tool Call、Tool Result 和增量输出；运行中的任务支持实时更新。
- **实时监控**：通过 Overview、Monitoring、Running Tasks 和活动流观察 Job 状态、并发任务、队列压力、Token 使用和运行中的容器。
- **扫描产物管理**：在 Files 中浏览任务输入、输出、Job Output、Agent Home 和其他 Artifact；可查看 Session、日志及结构化输出。
- **结果查看**：Full Scan 提供 Candidate、Analysis、Verification、Triage 和结果汇总；Research Pipeline 进一步提供 Findings、Tracks、Primitives 和 Chains 等研究实体视图。
- **资源与成本统计**：汇总 Input Tokens、Cache Read、Cache Write、Output Tokens、Thought Tokens、Total Tokens、估算成本和任务级消耗。
- **权限与隔离**：项目、Profile、Job、Task 和 Artifact 按组织权限访问；不同 Job 的运行目录、输入输出和 Agent 会话相互隔离。

### 适合 PPT 强调的价值

> 从项目和代码仓库出发，将复杂的 Agent 扫描流程转化为可追踪的 Job、Task、Session 和 Artifact，既能实时观察运行状态，也能保留完整的分析证据。

### 典型使用流程

```text
创建项目 → 配置仓库和 Profile → 选择 Pipeline / Runtime Profile
→ 启动 Scan Job → 观察任务队列和 Agent Session
→ 查看候选与研究结果 → 导出或审查 Files / Job Output
```

## 3. 数据集配置与评估

数据集模块用于批量、可重复地评估扫描流水线。数据集由多个样本组成，每个样本对应一个特定版本的代码仓库，并可关联描述已知漏洞的 Ground Truth Artifact。用户可以选择样本子集，用指定的流水线和运行 Profile 执行评测。

### 关键功能

- **数据集导入**：导入包含样本清单的 Manifest；样本记录代码仓库、特定版本或提交、样本标识和漏洞标签信息。
- **样本管理**：按样本查看仓库来源、版本、漏洞描述和 Ground Truth 文件；支持搜索、分页和批量选择样本。
- **Dataset Profile**：为同一个数据集保存样本选择、checkout 状态和运行前准备结果，支持精确 checkout 和重新 checkout。
- **Checkout 管理**：将样本代码准备到独立运行目录，构建或绑定对应的扫描工具镜像，并通过进度弹窗展示 Manifest 和 checkout 进度。
- **评估配置**：创建 Evaluation 时指定评估名称、扫描 Pipeline、Pipeline Runtime Profile、单次运行时间限制、每个样本的重复轮次以及参与评估的样本集合。
- **Trial 与 Scan Job**：系统为评估中的样本和轮次创建 Trial，并为每个 Trial 创建对应的 Scan Job；每个 Job 使用选定的流水线、模型、并发度和样本版本运行。
- **评估过程跟踪**：查看 Evaluation、Trial 和 Scan Job 的状态、开始时间、结束时间、任务阶段、Token 消耗、错误信息和运行产物。
- **超时处理**：单次 Trial 达到时间预算后进入超时终态，并继续执行必要的 Post Scan / 结果收集流程，而不是直接丢弃本次运行。
- **Job Output 收集**：从声明了 Job Output 的流水线阶段收集输出 Artifact，记录每个 Job 的有效输出文件列表；空 Artifact 列表不纳入 Ground Truth 比对。
- **Ground Truth 比对**：评估结束后启动独立的结果分析流程，将 Job Output Artifact 与样本 Ground Truth Artifact 进行匹配，判断每个已知漏洞是否被发现。
- **评估指标**：汇总每个样本、每个 Trial 和整体评估的命中结果，计算召回率，并保留命中明细、未命中样本和错误信息供后续分析。
- **结果钻取**：从 Trial 列表跳转到对应 Job 详情，沿用项目扫描中的 Overview、Tasks、Monitoring、Files 和 Session 页面检查具体过程。

### 适合 PPT 强调的价值

> 将“固定版本代码 + 已知漏洞标签 + 可配置扫描流水线”组合成可重复实验，通过 Trial、Job Output 和 Ground Truth 自动完成从运行到召回率统计的闭环评测。

### 典型使用流程

```text
导入数据集 → 配置 Dataset Profile → 选择样本并 Checkout
→ 选择 Pipeline / Runtime Profile / 时间预算 / 重复轮次
→ 创建 Evaluation → 执行 Trials 和 Scan Jobs
→ 收集 Job Output → 与 Ground Truth 比对 → 汇总召回率和明细
```

## 三大模块的协同关系

```text
流水线编辑与管理
        ↓ 发布 Pipeline 版本和 Runtime Profile
项目管理与扫描 ─────→ 单次项目 Scan Job、实时任务和漏洞分析结果
        ↓
数据集配置与评估 ──→ 多样本、多轮次 Trial、Ground Truth 比对和召回率
```

| 模块 | 核心对象 | 主要用户目标 | 典型产出 |
| --- | --- | --- | --- |
| 流水线编辑与管理 | Pipeline、Stage、Edge、Schema、Runtime Profile、Version | 定义和复用扫描流程 | 可发布、可审计、可视化的流水线版本 |
| 项目管理与扫描 | Project、Profile、Scan Job、Task、Session、Artifact | 对真实项目执行扫描并跟踪过程 | Candidate、Finding、分析结果、扫描产物 |
| 数据集配置与评估 | Dataset、Sample、Dataset Profile、Evaluation、Trial、Ground Truth | 对不同流水线进行可重复、可量化的比较 | 命中明细、召回率、评估报告 |
