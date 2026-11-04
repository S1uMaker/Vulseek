#!/bin/bash

# Vulseek 开发环境管理脚本 (使用 Docker Swarm)

set -e

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 配置变量
NETWORK_NAME="vulseek-dev-network"
POSTGRES_SERVICE="vulseek-postgres-dev"
REDIS_SERVICE="vulseek-redis-dev"
VULSEEK_SERVICE="vulseek-dev"
TRAEFIK_SERVICE="vulseek-traefik-dev"
IMAGE_NAME="vulseek-dev:latest"
ENV_FILE="env.development"

VULSEEK_PORT="${VULSEEK_DEV_PORT:-23000}"
POSTGRES_PORT="${POSTGRES_DEV_PORT:-25432}"
REDIS_PORT="${REDIS_DEV_PORT:-26379}"
TRAEFIK_HTTP_PORT="${TRAEFIK_DEV_HTTP_PORT:-20080}"
TRAEFIK_DASHBOARD_PORT="${TRAEFIK_DEV_DASHBOARD_PORT:-28080}"
NODE_DEBUG_PORT="${NODE_DEBUG_DEV_PORT:-29229}"
DRIZZLE_STUDIO_PORT="${DRIZZLE_STUDIO_DEV_PORT:-25555}"

ROOT_NODE_MODULES_VOLUME="vulseek_dev_root_node_modules"
APP_NODE_MODULES_VOLUME="vulseek_dev_app_node_modules"
SERVER_NODE_MODULES_VOLUME="vulseek_dev_server_node_modules"
APP_DATA_VOLUME="vulseek_dev_data"
DOCKER_CONFIG_VOLUME="vulseek_dev_docker_config"
POSTGRES_DATA_VOLUME="vulseek_dev_postgres_data"
REDIS_DATA_VOLUME="vulseek_dev_redis_data"
TRAEFIK_DATA_VOLUME="vulseek_dev_traefik_data"

# 当前脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SCAN_CONTEXT_HOST_PATH="${SCRIPT_DIR}/vulseek-data-dev"
SCAN_CONTEXT_HOST_PATH=""
PIPELINE_DEFINITIONS_HOST_PATH="${VULSEEK_SCAN_PIPELINE_DEFINITIONS_HOST_PATH:-${SCRIPT_DIR}/packages/server/src/services/scan}"
PIPELINE_DEFINITIONS_CONTAINER_PATH="/opt/vulseek/scan-pipeline"

resolve_scan_context_host_path() {
    local configured_path="${SCAN_CONTEXT_HOST_PATH:-${VULSEEK_SCAN_CONTEXT_HOST_PATH:-$DEFAULT_SCAN_CONTEXT_HOST_PATH}}"
    mkdir -p "$configured_path"
    (cd "$configured_path" && pwd -P)
}

resolve_pipeline_definitions_host_path() {
    local configured_path="${PIPELINE_DEFINITIONS_HOST_PATH}"
    if [ ! -d "$configured_path/pipeline/definitions" ]; then
        echo -e "${RED}❌ 外部 pipeline 配置目录无效: $configured_path${NC}" >&2
        echo -e "${YELLOW}需要包含 pipeline/definitions、prompts 和 stages 目录${NC}" >&2
        return 1
    fi
    (cd "$configured_path" && pwd -P)
}

rewrite_proxy_host() {
    local proxy_value="$1"
    if [ -z "$proxy_value" ]; then
        echo ""
        return 0
    fi
    # Build containers use Docker's default bridge gateway to reach host proxies.
    echo "$proxy_value" | sed -E 's#^(([a-zA-Z][a-zA-Z0-9+.-]*://)?([^/@]+@)?)([^/:?#]+)(:[0-9]+)?(.*)$#\1172.17.0.1\5\6#'
}

resolve_container_environment() {
    if [ -n "${VULSEEK_CONTAINER_ENV:-}" ]; then
        # The database setting may predate the internal Docker service name.
        # Preserve configured variables but always repair both proxy bypass
        # spellings before passing the environment to scan containers.
        printf '%s\n' "$VULSEEK_CONTAINER_ENV" | awk -v service="vulseek-dev" '
            function add_service(value,    item, parts, i) {
                if (value == "") value = "localhost,127.0.0.1,::1"
                count = split(value, parts, ",")
                for (i = 1; i <= count; i++) {
                    item = parts[i]
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", item)
                    if (item == service) return value
                }
                return value "," service
            }
            /^NO_PROXY=/ { no_proxy = substr($0, 10); next }
            /^no_proxy=/ { lower_no_proxy = substr($0, 10); next }
            NF { print }
            END {
                if (no_proxy == "") no_proxy = lower_no_proxy
                if (lower_no_proxy == "") lower_no_proxy = no_proxy
                print "NO_PROXY=" add_service(no_proxy)
                print "no_proxy=" add_service(lower_no_proxy)
            }
        '
        return 0
    fi

    local result=""
    local key value rewritten lower_key
    for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY; do
        value="${!key:-}"
        if [ -z "$value" ]; then
            lower_key="${key,,}"
            value="${!lower_key:-}"
        fi
        rewritten="$(rewrite_proxy_host "$value")"
        if [ -n "$rewritten" ]; then
            result+="${key}=${rewritten}\n${key,,}=${rewritten}\n"
        fi
    done

    value="${NO_PROXY:-${no_proxy:-}}"
    # Keep traffic to the dev service on the Docker network. Otherwise
    # runtime API calls from scan containers are sent through the host proxy.
    if [ -n "$value" ]; then
        value="${value},vulseek-dev"
    else
        value="localhost,127.0.0.1,::1,vulseek-dev"
    fi
    result+="NO_PROXY=${value}\nno_proxy=${value}\n"
    printf '%b' "$result"
}

service_exists() {
    docker service inspect "$1" >/dev/null 2>&1
}

port_is_listening() {
    local port="$1"
    ss -H -ltn 2>/dev/null | awk -v port=":${port}" '$4 ~ port "$" { found=1 } END { exit !found }'
}

require_available_port() {
    local port="$1"
    local service="$2"
    if ! service_exists "$service" && port_is_listening "$port"; then
        echo -e "${RED}❌ 端口 ${port} 已被其他进程或服务占用，无法启动 ${service}${NC}"
        return 1
    fi
}

list_environment_services() {
    docker service ls | awk -v app="$VULSEEK_SERVICE" -v postgres="$POSTGRES_SERVICE" \
        -v redis="$REDIS_SERVICE" -v traefik="$TRAEFIK_SERVICE" \
        'NR == 1 || $2 == app || $2 == postgres || $2 == redis || $2 == traefik'
}

resolve_service_name() {
    case "${1:-vulseek}" in
        vulseek|"$VULSEEK_SERVICE") echo "$VULSEEK_SERVICE" ;;
        postgres|"$POSTGRES_SERVICE") echo "$POSTGRES_SERVICE" ;;
        redis|"$REDIS_SERVICE") echo "$REDIS_SERVICE" ;;
        traefik|"$TRAEFIK_SERVICE") echo "$TRAEFIK_SERVICE" ;;
        *)
            echo -e "${RED}❌ 未知的开发环境服务: $1${NC}" >&2
            return 1
            ;;
    esac
}

wait_for_service_healthy() {
    local service="$1"
    local timeout_seconds="${2:-120}"
    local elapsed=0

    while [ "$elapsed" -lt "$timeout_seconds" ]; do
        local task_id
        task_id=$(docker service ps "$service" --filter desired-state=running -q | head -n1)
        if [ -n "$task_id" ]; then
            local container_id
            container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id" 2>/dev/null || true)
            if [ -n "$container_id" ]; then
                local health
                health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)
                if [ "$health" = "healthy" ] || [ "$health" = "running" ]; then
                    return 0
                fi
                if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
                    echo -e "${RED}❌ ${service} 状态异常: ${health}${NC}"
                    return 1
                fi
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done

    echo -e "${RED}❌ 等待 ${service} 健康状态超时${NC}"
    return 1
}

preflight_ports() {
    require_available_port "$POSTGRES_PORT" "$POSTGRES_SERVICE"
    require_available_port "$REDIS_PORT" "$REDIS_SERVICE"
    require_available_port "$VULSEEK_PORT" "$VULSEEK_SERVICE"
    require_available_port "$NODE_DEBUG_PORT" "$VULSEEK_SERVICE"
    require_available_port "$DRIZZLE_STUDIO_PORT" "$VULSEEK_SERVICE"
    require_available_port "$TRAEFIK_HTTP_PORT" "$TRAEFIK_SERVICE"
    require_available_port "$TRAEFIK_DASHBOARD_PORT" "$TRAEFIK_SERVICE"
}

# 显示帮助信息
show_help() {
    echo -e "${BLUE}Vulseek 开发环境管理脚本 (Docker Swarm)${NC}"
    echo ""
    echo "使用方法: ./dev.sh [命令] [选项]"
    echo ""
    echo "全局选项:"
    echo "  --scan-context-host-path PATH"
    echo "             指定宿主机 scan context 根目录，并挂载到 vulseek-dev:/scan-context"
    echo "             默认值: ${DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    echo ""
    echo "基础命令:"
    echo "  init        - 初始化 Docker Swarm 和网络"
    echo "  build       - 构建开发镜像"
    echo "  start       - 启动开发环境"
    echo "  stop        - 停止开发环境"
    echo "  restart     - 重启开发环境"
    echo "  clean       - 清理服务和卷"
    echo ""
    echo "日志与调试:"
    echo "  logs [服务]  - 查看日志（可选服务：vulseek, postgres, redis, traefik）"
    echo "  shell [服务] - 进入容器 shell（默认：vulseek）"
    echo "  ps          - 查看所有服务状态"
    echo ""
    echo "数据库操作:"
    echo "  db          - 进入 PostgreSQL 命令行"
    echo "  db:migrate  - 运行数据库迁移"
    echo "  db:seed     - 填充测试数据"
    echo "  db:studio   - 启动数据库管理界面"
    echo "  redis       - 进入 Redis 命令行"
    echo ""
    echo "开发工具:"
    echo "  install     - 安装依赖"
    echo "  test        - 运行测试"
    echo "  lint        - 代码检查"
    echo "  format      - 格式化代码"
    echo ""
    echo "环境配置:"
    echo "  env         - 编辑环境配置文件"
    echo "  env:show    - 显示当前环境配置"
    echo ""
    echo "其他:"
    echo "  status      - 显示服务状态和访问地址"
    echo "  update      - 更新服务（重新部署）"
    echo "  help        - 显示此帮助信息"
    echo ""
    echo "默认端口:"
    echo "  Vulseek ${VULSEEK_PORT}, PostgreSQL ${POSTGRES_PORT}, Redis ${REDIS_PORT}"
    echo "  Traefik HTTP ${TRAEFIK_HTTP_PORT}, Dashboard ${TRAEFIK_DASHBOARD_PORT}"
    echo "  Node debug ${NODE_DEBUG_PORT}, Drizzle Studio ${DRIZZLE_STUDIO_PORT}"
    echo "  可通过对应的 *_DEV_PORT 环境变量覆盖"
    echo ""
}

# 检查 Docker Swarm 是否初始化
check_swarm() {
    if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
        return 1
    fi
    return 0
}

# 检查环境文件
check_env_file() {
    if [ ! -f "$SCRIPT_DIR/$ENV_FILE" ]; then
        echo -e "${YELLOW}⚠️  环境文件不存在: $ENV_FILE${NC}"
        echo -e "${BLUE}💡 创建默认环境文件...${NC}"
        
        # 如果示例文件存在，复制它
        if [ -f "$SCRIPT_DIR/env.development.example" ]; then
            cp "$SCRIPT_DIR/env.development.example" "$SCRIPT_DIR/$ENV_FILE"
            echo -e "${GREEN}✅ 已从 env.development.example 创建 $ENV_FILE${NC}"
        else
            echo -e "${RED}❌ 环境文件不存在，且没有找到示例文件${NC}"
            echo -e "${YELLOW}💡 请手动创建 $ENV_FILE 文件${NC}"
            return 1
        fi
    fi
    
    echo -e "${GREEN}✅ 环境文件: $SCRIPT_DIR/$ENV_FILE${NC}"
    return 0
}

# 初始化 Docker Swarm
init_swarm() {
    echo -e "${BLUE}🔧 初始化 Docker Swarm...${NC}"
    
    if check_swarm; then
        echo -e "${YELLOW}⚠️  Swarm 已经初始化${NC}"
    else
        # 获取本地 IP
        local_ip=$(ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1)
        
        if [ -z "$local_ip" ]; then
            local_ip="127.0.0.1"
        fi
        
        echo -e "${BLUE}使用 IP: $local_ip${NC}"
        docker swarm init --advertise-addr "$local_ip" || {
            echo -e "${YELLOW}⚠️  Swarm 已存在，尝试继续...${NC}"
        }
    fi
    
    # 创建 overlay 网络
    echo -e "${BLUE}📡 创建网络: $NETWORK_NAME${NC}"
    docker network create --driver overlay --attachable "$NETWORK_NAME" 2>/dev/null || {
        echo -e "${YELLOW}⚠️  网络已存在${NC}"
    }
    
    # 创建卷
    echo -e "${BLUE}💾 创建数据卷...${NC}"
    docker volume create "$ROOT_NODE_MODULES_VOLUME" >/dev/null
    docker volume create "$APP_NODE_MODULES_VOLUME" >/dev/null
    docker volume create "$SERVER_NODE_MODULES_VOLUME" >/dev/null
    docker volume create "$APP_DATA_VOLUME" >/dev/null
    docker volume create "$DOCKER_CONFIG_VOLUME" >/dev/null
    docker volume create "$POSTGRES_DATA_VOLUME" >/dev/null
    docker volume create "$REDIS_DATA_VOLUME" >/dev/null
    docker volume create "$TRAEFIK_DATA_VOLUME" >/dev/null
    
    echo -e "${GREEN}✅ 初始化完成！${NC}"
}

# 构建开发镜像
build_image() {
    echo -e "${YELLOW}🔨 构建开发镜像: $IMAGE_NAME${NC}"
    cd "$SCRIPT_DIR"

    local build_http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
    local build_https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
    local build_all_proxy="${all_proxy:-${ALL_PROXY:-}}"
    local build_no_proxy="${no_proxy:-${NO_PROXY:-}}"
    build_http_proxy="$(rewrite_proxy_host "$build_http_proxy")"
    build_https_proxy="$(rewrite_proxy_host "$build_https_proxy")"
    build_all_proxy="$(rewrite_proxy_host "$build_all_proxy")"
    docker build --progress=plain \
        --build-arg http_proxy="$build_http_proxy" \
        --build-arg https_proxy="$build_https_proxy" \
        --build-arg all_proxy="$build_all_proxy" \
        --build-arg no_proxy="$build_no_proxy" \
        --build-arg HTTP_PROXY="$build_http_proxy" \
        --build-arg HTTPS_PROXY="$build_https_proxy" \
        --build-arg ALL_PROXY="$build_all_proxy" \
        --build-arg NO_PROXY="$build_no_proxy" \
        -f Dockerfile.dev \
        -t "$IMAGE_NAME" .
    echo -e "${GREEN}✅ 镜像构建完成${NC}"
}

# 启动 PostgreSQL 服务
start_postgres() {
    echo -e "${BLUE}🗄️  启动 PostgreSQL...${NC}"
    if service_exists "$POSTGRES_SERVICE"; then
        echo -e "${YELLOW}⚠️  PostgreSQL 服务已存在${NC}"
        return 0
    fi
    require_available_port "$POSTGRES_PORT" "$POSTGRES_SERVICE"
    
    docker service create \
        --name "$POSTGRES_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$POSTGRES_PORT",target=5432,mode=host \
        --env POSTGRES_USER=vulseek \
        --env POSTGRES_PASSWORD=vulseek_dev_password \
        --env POSTGRES_DB=vulseek \
        --mount type=volume,source="$POSTGRES_DATA_VOLUME",target=/var/lib/postgresql/data \
        --health-cmd "pg_isready -U vulseek" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        postgres:16 \
        -c wal_level=replica \
        -c archive_mode=on \
        -c archive_timeout=300 \
        -c wal_keep_size=1GB \
        -c max_wal_senders=10 \
        -c "archive_command=mkdir -p /var/lib/postgresql/data/wal_archive && test ! -f /var/lib/postgresql/data/wal_archive/%f && cp %p /var/lib/postgresql/data/wal_archive/%f"
}

# 启动 Redis 服务
start_redis() {
    echo -e "${BLUE}📦 启动 Redis...${NC}"
    if service_exists "$REDIS_SERVICE"; then
        echo -e "${YELLOW}⚠️  Redis 服务已存在${NC}"
        return 0
    fi
    require_available_port "$REDIS_PORT" "$REDIS_SERVICE"
    
    docker service create \
        --name "$REDIS_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$REDIS_PORT",target=6379,mode=host \
        --mount type=volume,source="$REDIS_DATA_VOLUME",target=/data \
        --health-cmd "redis-cli ping" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        redis:7
}

# 启动 Vulseek 主服务
start_vulseek() {
    echo -e "${BLUE}🚀 启动 Vulseek 主应用...${NC}"
    if service_exists "$VULSEEK_SERVICE"; then
        echo -e "${YELLOW}⚠️  Vulseek 服务已存在${NC}"
        return 0
    fi
    require_available_port "$VULSEEK_PORT" "$VULSEEK_SERVICE"
    require_available_port "$NODE_DEBUG_PORT" "$VULSEEK_SERVICE"
    require_available_port "$DRIZZLE_STUDIO_PORT" "$VULSEEK_SERVICE"
    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    local effective_pipeline_definitions_host_path
    effective_pipeline_definitions_host_path="$(resolve_pipeline_definitions_host_path)"
    export VULSEEK_SCAN_CONTEXT_HOST_PATH="$effective_scan_context_host_path"
    
    # 检查镜像是否存在
    if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  镜像不存在，开始构建...${NC}"
        build_image
    fi
    
    # 检查环境文件
    if ! check_env_file; then
        echo -e "${RED}❌ 环境文件检查失败${NC}"
        return 1
    fi
    
    # 构建环境变量文件路径
    local env_file_path="${SCRIPT_DIR}/${ENV_FILE}"
    echo -e "${BLUE}📝 使用环境文件: $env_file_path${NC}"
    echo -e "${BLUE}📁 Scan Context Host Path: ${effective_scan_context_host_path}${NC}"
    echo -e "${BLUE}📁 Pipeline Definitions Host Path: ${effective_pipeline_definitions_host_path}${NC}"
    
    # 读取环境文件并构建 --env 参数
    local env_args=""
    local has_container_environment=0
    while IFS= read -r line; do
        # 跳过注释和空行
        if [[ ! $line =~ ^[[:space:]]*# ]] && [[ -n $line ]]; then
            # 移除行尾注释
            line=$(echo "$line" | sed 's/#.*$//' | xargs)
            if [[ -n $line ]]; then
                env_args="$env_args --env $line"
                if [[ "$line" == VULSEEK_CONTAINER_ENV=* ]]; then
                    has_container_environment=1
                fi
            fi
        fi
    done < "$env_file_path"

    if [ "$has_container_environment" -eq 0 ]; then
        local container_environment
        container_environment="$(resolve_container_environment)"
        if [ -n "$container_environment" ]; then
            # The service command is assembled with eval; %q preserves the
            # multiline dotenv value without printing proxy credentials.
            env_args="$env_args --env $(printf '%q' "VULSEEK_CONTAINER_ENV=$container_environment")"
        fi
    fi
    
    echo -e "${GREEN}✅ 已加载环境变量${NC}"
    
    # 使用 eval 执行命令以正确处理环境变量
    eval docker service create \
        --name "$VULSEEK_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$VULSEEK_PORT",target=3000,mode=host \
        --publish published="$NODE_DEBUG_PORT",target=9229,mode=host \
        --publish published="$DRIZZLE_STUDIO_PORT",target=5555,mode=host \
        $env_args \
        --env VULSEEK_SERVICE_NAME="$VULSEEK_SERVICE" \
        --env VULSEEK_TOOLS_IMAGE_VARIANT=dev \
        --env VULSEEK_SCAN_CONTEXT_HOST_PATH="${effective_scan_context_host_path}" \
        --env VULSEEK_SCAN_CONTEXT_APP_PATH=/scan-context \
        --env VULSEEK_SCAN_PIPELINE_DEFINITIONS_PATH="${PIPELINE_DEFINITIONS_CONTAINER_PATH}" \
        --env VULSEEK_RESEARCH_DATABASE_URL="${VULSEEK_RESEARCH_DATABASE_URL:-postgresql://vulseek:vulseek_dev_password@${POSTGRES_SERVICE}:5432/vulseek}" \
        --env DATABASE_URL=postgresql://vulseek:vulseek_dev_password@"$POSTGRES_SERVICE":5432/vulseek \
        --env REDIS_URL=redis://"$REDIS_SERVICE":6379 \
        --mount type=bind,source="${SCRIPT_DIR}/apps",target=/app/apps \
        --mount type=bind,source="${SCRIPT_DIR}/agents",target=/app/agents \
        --mount type=bind,source="${SCRIPT_DIR}/packages",target=/app/packages \
        --mount type=bind,source="${SCRIPT_DIR}/vendor",target=/app/vendor \
        --mount type=bind,source="${SCRIPT_DIR}/package.json",target=/app/package.json \
        --mount type=bind,source="${SCRIPT_DIR}/pnpm-workspace.yaml",target=/app/pnpm-workspace.yaml \
        --mount type=bind,source="${env_file_path}",target=/app/.env \
        --mount type=volume,source="$ROOT_NODE_MODULES_VOLUME",target=/app/node_modules \
        --mount type=volume,source="$APP_NODE_MODULES_VOLUME",target=/app/apps/vulseek/node_modules \
        --mount type=volume,source="$SERVER_NODE_MODULES_VOLUME",target=/app/packages/server/node_modules \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
        --mount type=bind,source="${effective_scan_context_host_path}",target=/scan-context \
        --mount type=bind,source="${effective_pipeline_definitions_host_path}",target="${PIPELINE_DEFINITIONS_CONTAINER_PATH}",readonly \
        --mount type=volume,source="$APP_DATA_VOLUME",target=/etc/vulseek \
        --mount type=volume,source="$TRAEFIK_DATA_VOLUME",target=/etc/traefik \
        --mount type=volume,source="$DOCKER_CONFIG_VOLUME",target=/root/.docker \
        --constraint "'node.role==manager'" \
        "$IMAGE_NAME"
}

# 启动 Traefik 服务
start_traefik() {
    echo -e "${BLUE}🌐 启动 Traefik...${NC}"
    if service_exists "$TRAEFIK_SERVICE"; then
        echo -e "${YELLOW}⚠️  Traefik 服务已存在${NC}"
        return 0
    fi
    require_available_port "$TRAEFIK_HTTP_PORT" "$TRAEFIK_SERVICE"
    require_available_port "$TRAEFIK_DASHBOARD_PORT" "$TRAEFIK_SERVICE"
    
    docker service create \
        --name "$TRAEFIK_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$TRAEFIK_HTTP_PORT",target=80,mode=host \
        --publish published="$TRAEFIK_DASHBOARD_PORT",target=8080,mode=host \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly \
        --mount type=volume,source="$TRAEFIK_DATA_VOLUME",target=/etc/traefik \
        --constraint 'node.role==manager' \
        traefik:v3.6 \
        --api.insecure=true \
        --api.dashboard=true \
        --providers.swarm=true \
        --providers.swarm.endpoint=unix:///var/run/docker.sock \
        --providers.swarm.exposedbydefault=false \
        --providers.swarm.network="$NETWORK_NAME" \
        --entrypoints.web.address=:80 \
        --log.level=DEBUG \
        --accesslog=true
}

# 启动所有服务
start_all() {
    echo -e "${GREEN}🚀 启动 Vulseek 开发环境...${NC}"
    
    # 复用现有 Swarm，并确保开发环境自己的网络和卷存在。
    init_swarm
    
    preflight_ports

    # 按顺序启动服务，并在应用启动前等待依赖健康。
    start_postgres
    wait_for_service_healthy "$POSTGRES_SERVICE"
    start_redis
    wait_for_service_healthy "$REDIS_SERVICE"
    start_vulseek
    start_traefik
    
    echo ""
    echo -e "${GREEN}✅ 开发环境已启动！${NC}"
    echo -e "${BLUE}📱 访问: http://localhost:${VULSEEK_PORT}${NC}"
    echo -e "${BLUE}🐛 调试端口: localhost:${NODE_DEBUG_PORT}${NC}"
    echo ""
    echo -e "${YELLOW}💡 提示: 使用 './dev.sh status' 查看服务状态${NC}"
}

# 停止所有服务
stop_all() {
    echo -e "${YELLOW}⏹️  停止 Vulseek 开发环境...${NC}"
    
    docker service rm "$VULSEEK_SERVICE" 2>/dev/null || true
    docker service rm "$TRAEFIK_SERVICE" 2>/dev/null || true
    docker service rm "$REDIS_SERVICE" 2>/dev/null || true
    docker service rm "$POSTGRES_SERVICE" 2>/dev/null || true
    
    echo -e "${GREEN}✅ 开发环境已停止${NC}"
}

# 重启服务
restart_service() {
    local service
    service=$(resolve_service_name "${1:-vulseek}")
    echo -e "${YELLOW}🔄 重启服务: $service${NC}"
    docker service update --force "$service"
    echo -e "${GREEN}✅ 服务已重启${NC}"
}

# 查看日志
show_logs() {
    local service_name
    service_name=$(resolve_service_name "${1:-vulseek}")
    
    echo -e "${BLUE}📋 查看 $service_name 日志 (Ctrl+C 退出)${NC}"
    
    # 获取任务 ID
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        # 获取容器 ID
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker logs -f "$container_id"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ 服务未运行${NC}"
    fi
}

# 进入容器 shell
enter_shell() {
    local service_name
    service_name=$(resolve_service_name "${1:-vulseek}")
    
    echo -e "${BLUE}🐚 进入 $service_name 容器 shell...${NC}"
    
    # 获取任务 ID
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        # 获取容器 ID
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" bash || docker exec -it "$container_id" sh
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ 服务未运行${NC}"
    fi
}

# 查看服务状态
show_status() {
    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    echo -e "${BLUE}📊 服务状态:${NC}"
    echo ""
    list_environment_services
    echo ""
    echo -e "${GREEN}🌐 访问地址:${NC}"
    echo -e "  ${BLUE}主应用:${NC}        http://localhost:${VULSEEK_PORT}"
    echo -e "  ${BLUE}调试端口:${NC}      localhost:${NODE_DEBUG_PORT}"
    echo -e "  ${BLUE}Traefik 面板:${NC}  http://localhost:${TRAEFIK_DASHBOARD_PORT}"
    echo -e "  ${BLUE}PostgreSQL:${NC}    localhost:${POSTGRES_PORT} (用户: vulseek, 密码: vulseek_dev_password)"
    echo -e "  ${BLUE}Redis:${NC}         localhost:${REDIS_PORT}"
    echo -e "  ${BLUE}Scan Context:${NC}  ${effective_scan_context_host_path}"
    echo ""
}

# 进入 PostgreSQL
enter_db() {
    echo -e "${BLUE}🗄️  进入 PostgreSQL 命令行...${NC}"
    enter_shell postgres
    # 在进入后执行 psql
    # 注意：这个命令在上面的 enter_shell 结束后不会执行
}

# 直接连接数据库
connect_db() {
    echo -e "${BLUE}🗄️  连接 PostgreSQL...${NC}"
    
    task_id=$(docker service ps "$POSTGRES_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" psql -U vulseek -d vulseek
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ PostgreSQL 服务未运行${NC}"
    fi
}

# 数据库迁移（推送 schema）
db_migrate() {
    echo -e "${BLUE}🔄 运行数据库迁移...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" sh -c "cd apps/vulseek && pnpm db:push"
            echo -e "${GREEN}✅ 数据库迁移完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 数据库填充
db_seed() {
    echo -e "${BLUE}🌱 填充测试数据...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" sh -c "cd apps/vulseek && pnpm db:seed"
            echo -e "${GREEN}✅ 测试数据填充完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 数据库管理界面
db_studio() {
    echo -e "${BLUE}🎨 启动数据库管理界面...${NC}"
    echo -e "${YELLOW}💡 Drizzle Studio 将在 http://localhost:${DRIZZLE_STUDIO_PORT} 启动${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" sh -c "cd apps/vulseek && pnpm db:studio"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 进入 Redis
enter_redis() {
    echo -e "${BLUE}📦 进入 Redis 命令行...${NC}"
    
    task_id=$(docker service ps "$REDIS_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" redis-cli
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Redis 服务未运行${NC}"
    fi
}

# 安装依赖
install_deps() {
    echo -e "${BLUE}📦 安装依赖...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm install
            echo -e "${GREEN}✅ 依赖安装完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 运行测试
run_tests() {
    echo -e "${BLUE}🧪 运行测试...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm test
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 代码检查
run_lint() {
    echo -e "${BLUE}🔍 代码检查...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm format-and-lint
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 格式化代码
run_format() {
    echo -e "${BLUE}✨ 格式化代码...${NC}"
    
    task_id=$(docker service ps "$VULSEEK_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm format-and-lint:fix
            echo -e "${GREEN}✅ 代码格式化完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Vulseek 服务未运行${NC}"
    fi
}

# 编辑环境文件
edit_env() {
    local env_path="${SCRIPT_DIR}/${ENV_FILE}"
    
    # 如果文件不存在，先创建
    if [ ! -f "$env_path" ]; then
        echo -e "${YELLOW}⚠️  环境文件不存在，创建新文件...${NC}"
        if [ -f "$SCRIPT_DIR/env.development.example" ]; then
            cp "$SCRIPT_DIR/env.development.example" "$env_path"
            echo -e "${GREEN}✅ 已从示例文件创建 $ENV_FILE${NC}"
        else
            touch "$env_path"
            echo -e "${YELLOW}⚠️  创建空环境文件${NC}"
        fi
    fi
    
    # 使用默认编辑器打开
    local editor="${EDITOR:-vi}"
    echo -e "${BLUE}📝 使用 $editor 编辑环境文件...${NC}"
    "$editor" "$env_path"
    
    echo -e "${GREEN}✅ 环境文件已保存${NC}"
    echo -e "${YELLOW}💡 提示: 修改环境文件后需要运行 './dev.sh update vulseek' 使更改生效${NC}"
}

# 显示环境配置
show_env() {
    local env_path="${SCRIPT_DIR}/${ENV_FILE}"
    
    if [ ! -f "$env_path" ]; then
        echo -e "${RED}❌ 环境文件不存在: $ENV_FILE${NC}"
        echo -e "${YELLOW}💡 运行 './dev.sh env' 创建环境文件${NC}"
        return 1
    fi
    
    echo -e "${BLUE}📝 环境配置文件: $env_path${NC}"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # 显示文件内容，但隐藏敏感信息
    while IFS= read -r line; do
        # 隐藏包含敏感信息的行
        if [[ $line =~ ^[[:space:]]*#.* ]] || [[ -z $line ]]; then
            # 注释和空行直接显示
            echo "$line"
        elif [[ $line =~ (PASSWORD|SECRET|KEY|TOKEN)= ]]; then
            # 敏感信息行部分隐藏
            key=$(echo "$line" | cut -d'=' -f1)
            echo "${key}=********"
        else
            # 其他行正常显示
            echo "$line"
        fi
    done < "$env_path"
    
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${YELLOW}💡 提示: 敏感信息（PASSWORD、SECRET、KEY、TOKEN）已隐藏${NC}"
    echo -e "${YELLOW}💡 运行 './dev.sh env' 编辑完整配置${NC}"
}

# 更新服务
update_service() {
    local service
    service=$(resolve_service_name "${1:-vulseek}")
    echo -e "${YELLOW}🔄 更新服务: $service${NC}"
    
    # 如果是 Vulseek 服务，重新构建镜像
    if [ "$service" = "$VULSEEK_SERVICE" ] || [ "$service" = "vulseek" ]; then
        build_image
        docker service update --image "$IMAGE_NAME" --force "$VULSEEK_SERVICE"
    else
        docker service update --force "$service"
    fi
    
    echo -e "${GREEN}✅ 服务已更新${NC}"
}

# 清理
clean_all() {
    echo -e "${RED}🧹 清理服务和资源...${NC}"
    read -p "这将删除所有开发服务和数据卷，确认吗？(y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # 停止服务
        stop_all
        
        # 删除网络
        echo -e "${BLUE}📡 删除网络...${NC}"
        docker network rm "$NETWORK_NAME" 2>/dev/null || true
        
        # 删除卷
        echo -e "${BLUE}💾 删除数据卷...${NC}"
        read -p "是否删除数据卷（包括数据库数据）？(y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker volume rm "$ROOT_NODE_MODULES_VOLUME" 2>/dev/null || true
            docker volume rm "$APP_NODE_MODULES_VOLUME" 2>/dev/null || true
            docker volume rm "$SERVER_NODE_MODULES_VOLUME" 2>/dev/null || true
            docker volume rm "$APP_DATA_VOLUME" 2>/dev/null || true
            docker volume rm "$DOCKER_CONFIG_VOLUME" 2>/dev/null || true
            docker volume rm "$POSTGRES_DATA_VOLUME" 2>/dev/null || true
            docker volume rm "$REDIS_DATA_VOLUME" 2>/dev/null || true
            docker volume rm "$TRAEFIK_DATA_VOLUME" 2>/dev/null || true
        fi
        
        # 删除镜像
        read -p "是否删除开发镜像？(y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker rmi "$IMAGE_NAME" 2>/dev/null || true
        fi
        
        echo -e "${GREEN}✅ 清理完成${NC}"
    else
        echo -e "${YELLOW}❌ 取消清理${NC}"
    fi
}

# 参数解析
COMMAND="${1:-}"
if [ -n "$COMMAND" ]; then
    shift
fi
POSITIONAL_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --scan-context-host-path)
            if [ -z "${2:-}" ]; then
                echo -e "${RED}❌ --scan-context-host-path 需要一个路径参数${NC}"
                exit 1
            fi
            SCAN_CONTEXT_HOST_PATH="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# 主命令处理
case "$COMMAND" in
    init)
        init_swarm
        ;;
    build)
        build_image
        ;;
    start)
        start_all
        ;;
    stop)
        stop_all
        ;;
    restart)
        restart_service "${POSITIONAL_ARGS[0]}"
        ;;
    logs)
        show_logs "${POSITIONAL_ARGS[0]}"
        ;;
    shell)
        enter_shell "${POSITIONAL_ARGS[0]}"
        ;;
    ps|status)
        show_status
        ;;
    db)
        connect_db
        ;;
    db:migrate)
        db_migrate
        ;;
    db:seed)
        db_seed
        ;;
    db:studio)
        db_studio
        ;;
    redis)
        enter_redis
        ;;
    install)
        install_deps
        ;;
    test)
        run_tests
        ;;
    lint)
        run_lint
        ;;
    format)
        run_format
        ;;
    env)
        edit_env
        ;;
    env:show)
        show_env
        ;;
    update)
        update_service "${POSITIONAL_ARGS[0]}"
        ;;
    clean)
        clean_all
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        if [ -z "$COMMAND" ]; then
            show_help
        else
            echo -e "${RED}❌ 未知命令: $COMMAND${NC}"
            echo ""
            show_help
            exit 1
        fi
        ;;
esac
