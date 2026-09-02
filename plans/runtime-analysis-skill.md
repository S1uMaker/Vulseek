# 新增 `runtime-analysis` skill

给 agent 一套可执行的动态分析工作法：真正构建/运行被测程序（或其中一部分），用运行、输入、调试判断动态路径，验证候选的可达性、危害和利用性。

技能目录：`agents/skills/runtime-analysis/`（`listAvailableAgentSkills` 会自动进 pipeline 编辑器目录）。

## 两类目标

**二进制（C/C++/Rust CLI 与库）**  
在当前 **task 目录** 下构建和运行（`$TASK_DIR/runtime-bin/`）：产物、日志、输入、core、gdb 记录都留在该 task 下，不跨 task 复用。优先现有构建系统；需要时加 ASan/UBSan（已有 `address-sanitizer` skill）。库用最小 driver/harness，不要为了跑起来重写整个项目。

**Web**  
先查 **本 job 是否已有在跑的 web 栈**；有则复用，没有再起。

- Compose **project name**：`vulseek-{projectSlug}`（小写、非 `[a-z0-9-]` 换成 `-`），必须以 `vulseek-` 开头。
- Compose 文件可以写在 **当前 task 目录**，但必须同时在 **job 级登记**，否则 8 个 hunter 会起 8 套。
- Job 级登记：`$VULSEEK_PROJECT_PROFILE_DIR/jobs/$VULSEEK_SCAN_JOB_ID/runtime-web/`
  - `runtime-web.json`：`projectName`、`composeFile`、`baseUrl`、`status`
  - `runtime-web.lock`：进程间互斥锁文件
- 复用判定：读登记文件 + `docker compose -p vulseek-… ps`。已 healthy/running 就用登记的 `baseUrl`，不要再 `up`。
- 新起：按仓库现有 Dockerfile/compose 生成最小 compose，挂到与扫描容器相同的 Docker network，再 `up -d`。

**从写 compose 到构建、启动、使用、调试，全程必须由 Python helper 加排他锁。** 目的是整个 job 最多一套 Web 实例，且同一时刻只有一个 stage 在动它。Agent 不得自己写 compose、不得自己 `docker compose` / `docker build`、不得在锁外 curl/gdb 打这套服务，也不得用 shell `flock`。锁在 Python 里获取，进程退出才释放。

二进制不走 compose；Web 不在扫描容器内直接 `php -S` 冒充复用。

## 技能内容（SKILL.md）

Frontmatter：`name: runtime-analysis` + 一段 description。

工作流：

1. 判断目标是二进制还是 Web（语言、入口、是否 HTTP 服务）。
2. 二进制：构建 → 用候选相关输入跑 → gdb/lldb/日志确认路径是否打到 sink。
3. Web：整段动态工作包进一次 `runtime_web.py with-lock`（或它拉起的持锁子进程）。在锁内才允许：写 compose、`compose build`、`up`、HTTP/调试。锁外禁止碰实例。
4. 记录证据：命令、exit、输入、响应、栈、是否崩溃、是否越权/SSRF 等到 task 目录。
5. 达不到就写清 blocker（缺依赖、构建失败、服务没起来），不要假装动态验证过。

## Web 锁（Python，强制，全程排他）

并行 stage 会抢同一套实例，写 compose / build / up 会起第二套，使用和调试会把 DB、options、上传目录改乱。从生成 compose 到调试结束，全部走 helper 的 **排他锁**（`fcntl.flock` `LOCK_EX`）。不用共享锁：只读探测也要等，避免和别人的 build/up/写库交错。

`agents/skills/runtime-analysis/runtime_web.py`

锁文件：job 级 `runtime-web.lock`。锁跟 Python 进程走，子命令返回或进程被杀才释放。禁止 check-then-act（看一眼就放锁再 build/up）。

**一次持锁覆盖整段 Web 工作**，不要 prepare / build / up / curl 各拿一次锁——中间放锁，另一个 hunter 会插进来起第二套或改状态。推荐：

```bash
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" \
  with-lock --timeout SECONDS -- bash -lc '... 写 compose、build、up、请求、调试 ...'
```

`with-lock` 先 `LOCK_EX`，再在锁内：若登记且 `compose ps` 已 running 则复用；否则允许写 compose、登记、`compose build`、`up -d`。然后执行 `--` 后的命令（使用、调试）。命令结束释放锁。已有实例时跳过 build/up，但仍持锁直到使用/调试结束。

也提供同锁下的分步命令（给 helper 内部或测试用）。Agent 技能正文要求优先 `with-lock` 包住全过程：

```bash
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" prepare --compose FILE
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" build
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" up [--base-url-hint URL]
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" url
python3 "$VULSEEK_AGENT_HOME/skills/runtime-analysis/runtime_web.py" exec -- <cmd...>
```

每一步自己也 `LOCK_EX`，避免有人绕过 `with-lock` 只调 `up` 时起两套。分步之间会短暂放锁，所以 SKILL.md 写明：**正常路径只用 `with-lock` 包住 prepare→build→up→use→debug。**

| 阶段 | 必须在锁内 | 说明 |
|------|------------|------|
| 写 / 生成 `docker-compose.yml` | 是 | `prepare`。未持锁禁止创建第二份 compose 并 `up` |
| `compose build` / 构建镜像 | 是 | `build`。未持锁禁止 `docker build` |
| `compose up` / 启动 | 是 | `up`。已 running 则复用，绝不第二套 |
| 使用（HTTP、登录、表单、脚本打接口） | 是 | `with-lock` / `exec` |
| 调试（日志、`compose exec`、db shell、改 option/插件） | 是 | 同上。写库只允许在这段持锁窗口里 |

`status` 只读登记也可以短持 `LOCK_EX`（实现简单，避免 SH/EX 混用）。超时 `--timeout` 到期返回非 0，不 `compose down`。Job cancel 才 `down`。

技能正文只写这些命令。禁止 agent 直接 `docker compose`、`docker build`、对实例 curl/`mysql`/`wp`。

## 运行时（Web 必需）

现在扫描容器 **没有 docker CLI，也没挂 docker.sock**，agent 无法 `docker compose`。

1. `Dockerfile.scan-tools` 安装 `docker-ce-cli` + `docker-compose-plugin`。
2. `docker run` 扫描容器时增加 `-v /var/run/docker.sock:/var/run/docker.sock`（与 Vulseek 主服务一样，docker-from-docker）。Compose 打在 **宿主机 daemon** 上，扫描容器用登记的 URL/端口访问。
3. Job cancel / 全部终态时 `docker compose -p vulseek-… down`，避免栈泄漏。读 job 级 `runtime-web.json`，没有则跳过。

扫描容器因此能起任意名为 `vulseek-*` 的 compose。技能必须禁止操作非 `vulseek-` 前缀的项目。

## 挂到哪些 stage

这是 **technique skill**，不新开 stage。

挂到会做动态验证的地方：

- orch-hunt：`hunter`
- full / delta：`analyze-finding`（候选深挖）
- 可选：`scan-target`

**不挂** `verify-finding`：现有 verify 明确只做事实核对，不判利用性。  
**不挂** `triage-finding`：它消费已有证据做分类。

Pipeline 编辑器里也可以手动加。`injectSkillListIntoPrompt` 会在 prompt 里列出 SKILL.md 路径。

## 测试

- `listAvailableAgentSkills` 能读到 `runtime-analysis` 的 name/description。
- orch-hunt hunter YAML 含该 skill；prompt 注入含 `skills/runtime-analysis/SKILL.md`。
- `runtime_web.py`：project name 规范化；`with-lock` 覆盖 prepare/build/up/use；并发只有一方 `compose up`（mock docker + 真 `fcntl.flock`）；一方持锁时另一方 `prepare`/`build`/`up`/`with-lock` 阻塞或超时，不会起第二套。
- 扫描容器 `docker run` 命令含 docker.sock（源码/单测断言）。
- Job 清理路径会 `compose down`（mock）。
