# Dataset Evaluation 直接复用 Tools Image 计划

## Summary

Dataset Profile checkout 不再构建 `vulseek-dataset-profile-*` 包装镜像。checkout 只负责确认当前 content-hash tools image 可用、在该镜像中校验 Dataset manifest 和 artifact 路径，并保存 sample index 与被选中的 tools image 引用。Dataset Evaluation task、Session、Files 和 Ground Truth scoring 统一使用 Profile checkout 时固定的 tools image。

当前 `buildCheckoutImage()` 生成的 Dockerfile 只有 `FROM <tools-image>` 和两个 `mkdir`，而 Evaluation runtime 与 scoring 实际均重新调用 `resolveDatasetToolsImage()`，从未使用这个包装镜像。该构建、镜像字段和清理逻辑属于重复实现，应一并删除或改名，不能继续保留误导性的 `checkoutImage` 语义。

## Data Model

- 将 `dataset_profiles.checkoutImage` 重命名为 `toolsImageTag`。
- 将 `dataset_profiles.checkoutImageDigest` 重命名为 `toolsImageDigest`。
- 新增 Drizzle migration；不修改已经发布的 `0222_dataset_evaluation.sql`。
- 旧字段保存的是 `vulseek-dataset-profile-*`，不能直接当成 tools image。migration 清空旧值，并把受影响的 `ready` Profile 标记为需要重新 checkout，避免 Evaluation 使用错误镜像。
- Profile checkout 成功时保存精确的 content-hash tag 和 Docker image ID。Evaluation 必须使用这组固定值，而不是从 `docker images | head -n 1` 动态选择镜像。
- `sourceDigest`、manifest snapshot 和 sample selection 保持不变；本次不扩大到无关字段清理。

## Backend Changes

### Canonical Tools Image Resolution

- 把当前 tools definition、tag 计算、label 校验和 image inspect 收敛到无循环依赖的共享 service。
- 提供单一接口 `resolveRequiredToolsImage()`，返回 `{ imageTag, imageId, version, variant }`；镜像缺失、tag 不匹配或 labels 不匹配时明确失败。
- 删除 `dataset.ts` 中通过 `docker images ... | head -n 1` 实现的 `resolveDatasetToolsImage()`，避免多版本并存时选择不确定。
- Scan checkout、Dataset checkout、Dataset Evaluation runtime 和 scoring 共享同一解析规则。

### Dataset Checkout

- 删除 `buildCheckoutImage()`、临时目录、动态生成的 `Dockerfile`、`docker build --pull=false` 和随机 dataset image tag。
- 保留 manifest 校验容器；该容器直接使用 canonical tools image，并继续只读挂载 Dataset host root。
- checkout 流程调整为：
  1. 校验 host root 与 tools image；
  2. 读取并校验 `manifest.json`、repositoryPath 和 groundTruthArtifacts；
  3. 事务化替换 sample index、selected sample IDs，并保存 tools image tag/digest；
  4. 将 Profile 标记为 `ready`。
- 删除 `building_image` phase；新增或使用 `checking_tools`，最终阶段保留 `saving_profile`。
- Dataset checkout task 返回 `toolsImageTag`，不再返回 `checkoutImage`。

### Evaluation Runtime

- `resolveDatasetTrialRuntime()` 返回 Profile 固定的 `toolsImageTag/toolsImageDigest`。
- Task container、persistent lane、live session、Files 和 post-scan scoring 全部使用固定 tag。
- 启动 Trial 和 scoring 前执行 `docker image inspect` 并比对 image ID；缺失或 digest 不一致时提示重新 checkout Profile，不静默切换到最新 tools image。
- Evaluation 创建时要求 Profile 为 `ready` 且 tools image 引用完整。

### Cleanup

- 删除 `pruneDatasetProfile()` 中删除 `vulseek-dataset-profile-*` 的 `docker rmi` 逻辑；Profile 不拥有共享 tools image，删除 Profile 时绝不能删除它。
- 删除 Dataset API、类型、序列化结果和测试 fixture 中无用的 `checkoutImage/checkoutImageDigest` 名称。
- 删除不再需要的 `os`、随机 image tag、`sanitizeSegment()` 等 imports/helper；保留 checkout task ID 所需的 `nanoid`。
- 保留 `Dockerfile.scan-tools`，它仍是共享 tools image 的真实构建定义；仅删除 Dataset checkout 动态生成的无用 Dockerfile。
- Application/Compose 的 checkout image 流程不属于本次删除范围。

## Frontend Changes

- Dataset Profile checkout 对话框增加共享 Tools Image 状态区，复用 `checkoutToolsStatus`、`rebuildCheckoutTools` 和 build log 查询。
- `owner/admin` 在镜像缺失或过期时可直接执行 `Build tools image` / `Rebuild tools image`；`member` 只显示状态和权限说明。
- 点击 Dataset Checkout 前先显示 tools image tag、version、状态；前端预检只改善反馈，后端仍必须再次校验。
- checkout 进度改为 `Check tools image`、`Validate manifest and samples`、`Save profile and sample index`，删除 `Build checkout image`。
- Profile Overview 展示 `Tools image` 及可复制的短 hash，不再使用 Checkout image 文案。
- 若 Profile 使用的固定 tools image 已被删除，显示 `Re-checkout required`，而不是让 Evaluation 在启动后才报模糊错误。

## Migration And Compatibility

- migration 执行后，已有 Dataset Profile 需要重新 checkout；不尝试从旧包装镜像反推 tools image。
- 已在运行的 Evaluation 不在 migration 中自动重写或重启。部署前应确认没有 active Dataset Evaluation，或先完成/取消后再迁移。
- 不自动删除历史 `vulseek-dataset-profile-*` 镜像。提供独立 dry-run 清理命令列出无引用旧镜像，确认后再删除，避免 schema migration 执行 Docker 副作用。
- Profile recheckout 后使用当前 content-hash tools image；后续 tools image 更新不会改变已有 Profile 的运行基线，必须显式 recheckout 才升级。

## Tests

- Service tests：tools image 存在、缺失、labels 不匹配、digest 变化、多版本并存，以及 checkout 全程不调用 `docker build`。
- Persistence tests：checkout 原子保存 samples 与 tools image 引用；失败不留下半更新 Profile；旧 Profile migration 后要求 recheckout。
- Runtime tests：Task、lane、session 和 scoring 使用 Profile 固定 tag；镜像缺失或 image ID 不一致时拒绝启动。
- Router tests：owner/admin 可构建 tools image，member 只能查看；Dataset checkout 权限和 active Evaluation lock 保持有效。
- UI tests：Tools image missing/ready/building/failed、构建日志、checkout 三阶段进度、recheckout required 和错误提示。
- Browser 验证：在 dev 中构建 tools image，checkout 一个 Dataset Profile，确认没有新增 `vulseek-dataset-profile-*`，再启动短 Evaluation 并核对 Task 容器 image 与 Profile 保存的 tag 一致。
- 验证命令：
  - `pnpm --filter vulseek test`
  - `pnpm --filter @vulseek/server typecheck`
  - `pnpm --filter vulseek typecheck`
  - `git diff --check`

## Acceptance Criteria

- Dataset checkout 不创建 Dockerfile、不执行 Docker build、不生成 profile 专属镜像。
- Profile、Trial task 和 scoring 使用同一个固定 tools image tag/digest。
- Tools image 缺失时，owner/admin 能在 Dataset Profile 页面构建并查看日志。
- 代码中不再存在 Dataset 语义的 `checkoutImage`、随机 profile image tag或 profile-owned image removal。
- 删除 Profile 不会删除共享 tools image。
- Application/Compose checkout 行为不受影响。
