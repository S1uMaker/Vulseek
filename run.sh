#!/bin/bash

# Vulseek release environment manager. Pulls the GHCR release image.

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

NETWORK_NAME="vulseek-release-network"
POSTGRES_SERVICE="vulseek-postgres-release"
REDIS_SERVICE="vulseek-redis-release"
VULSEEK_SERVICE="vulseek-release"
TRAEFIK_SERVICE="vulseek-traefik-release"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/fuzzing-peach/vulseek}"
RELEASE_TAG="${RELEASE_TAG:-latest}"
IMAGE_NAME="${IMAGE_REPOSITORY}:${RELEASE_TAG}"
BUILD_IMAGE_NAME="${BUILD_IMAGE_NAME:-vulseek-release:local}"
ENV_FILE="${ENV_FILE:-.env.production}"

VULSEEK_PORT="${VULSEEK_RELEASE_PORT:-33000}"
POSTGRES_PORT="${POSTGRES_RELEASE_PORT:-35432}"
REDIS_PORT="${REDIS_RELEASE_PORT:-36379}"
TRAEFIK_HTTP_PORT="${TRAEFIK_RELEASE_HTTP_PORT:-30080}"
TRAEFIK_DASHBOARD_PORT="${TRAEFIK_RELEASE_DASHBOARD_PORT:-38080}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SCAN_CONTEXT_HOST_PATH="${SCRIPT_DIR}/vulseek-data-release"
SCAN_CONTEXT_HOST_PATH="${VULSEEK_SCAN_CONTEXT_HOST_PATH:-}"
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
        echo "External pipeline configuration directory is invalid: $configured_path" >&2
        echo "It must contain pipeline/definitions, prompts, and stages directories." >&2
        return 1
    fi
    (cd "$configured_path" && pwd -P)
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
        echo -e "${RED}Port ${port} is already used by another process or service; cannot start ${service}.${NC}"
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
            echo -e "${RED}Unknown release service: $1${NC}" >&2
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
                    echo -e "${RED}${service} entered ${health} state.${NC}"
                    return 1
                fi
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done

    echo -e "${RED}Timed out waiting for ${service} to become healthy.${NC}"
    return 1
}

preflight_ports() {
    require_available_port "$POSTGRES_PORT" "$POSTGRES_SERVICE"
    require_available_port "$REDIS_PORT" "$REDIS_SERVICE"
    require_available_port "$VULSEEK_PORT" "$VULSEEK_SERVICE"
    require_available_port "$TRAEFIK_HTTP_PORT" "$TRAEFIK_SERVICE"
    require_available_port "$TRAEFIK_DASHBOARD_PORT" "$TRAEFIK_SERVICE"
}

show_help() {
    echo -e "${BLUE}Vulseek release environment manager (Docker Swarm)${NC}"
    echo ""
    echo "Usage: ./run.sh [command] [options]"
    echo ""
    echo "Options:"
    echo "  --scan-context-host-path PATH"
    echo "             Host scan context root mounted to /scan-context"
    echo "             Default: ${DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    echo ""
    echo "Commands:"
    echo "  init        Initialize Docker Swarm, network, and volumes"
    echo "  build       Build the local release image (${BUILD_IMAGE_NAME}) from Dockerfile"
    echo "  pull        Pull ${IMAGE_NAME}"
    echo "  start       Start the release environment"
    echo "  stop        Stop release services"
    echo "  restart     Force restart the Vulseek release service"
    echo "  logs [svc]  Follow logs for vulseek, postgres, redis, or traefik"
    echo "  ps          Show release services"
    echo "  status      Show service status and URLs"
    echo "  clean       Remove services and release volumes"
    echo "  help        Show this help"
    echo ""
    echo "Default ports:"
    echo "  Vulseek ${VULSEEK_PORT}, PostgreSQL ${POSTGRES_PORT}, Redis ${REDIS_PORT}"
    echo "  Traefik HTTP ${TRAEFIK_HTTP_PORT}, Dashboard ${TRAEFIK_DASHBOARD_PORT}"
    echo "  Override them with the corresponding *_RELEASE_PORT variables."
    echo ""
}

check_swarm() {
    docker info 2>/dev/null | grep -q "Swarm: active"
}

init_swarm() {
    echo -e "${BLUE}Initializing Docker Swarm...${NC}"

    if ! check_swarm; then
        local_ip=$(ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1)
        if [ -z "$local_ip" ]; then
            local_ip="127.0.0.1"
        fi
        docker swarm init --advertise-addr "$local_ip" || true
    fi

    docker network create --driver overlay --attachable "$NETWORK_NAME" 2>/dev/null || true
    docker volume create vulseek_release_data >/dev/null
    docker volume create docker_release_config >/dev/null
    docker volume create postgres_release_data >/dev/null
    docker volume create redis_release_data >/dev/null
    docker volume create traefik_release_data >/dev/null

    echo -e "${GREEN}Release environment initialized${NC}"
}

check_env_file() {
    if [ ! -f "$SCRIPT_DIR/$ENV_FILE" ]; then
        echo -e "${RED}Environment file not found: $SCRIPT_DIR/$ENV_FILE${NC}"
        echo -e "${YELLOW}Set ENV_FILE or create .env.production before starting release.${NC}"
        return 1
    fi
}

rewrite_proxy_host() {
    local proxy_value="$1"
    if [ -z "$proxy_value" ]; then
        echo ""
        return 0
    fi
    echo "$proxy_value" | sed -E 's#^(([a-zA-Z][a-zA-Z0-9+.-]*://)?([^/@]+@)?)([^/:?#]+)(:[0-9]+)?(.*)$#\1172.17.0.1\5\6#'
}

pull_image() {
    if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}Using local release image: ${IMAGE_NAME}${NC}"
        return 0
    fi
    echo -e "${BLUE}Pulling release image: ${IMAGE_NAME}${NC}"
    docker pull --platform linux/amd64 "$IMAGE_NAME"
}

build_image() {
    echo -e "${YELLOW}Building release image: ${BUILD_IMAGE_NAME}${NC}"
    cd "$SCRIPT_DIR"

    local build_http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
    local build_https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
    local build_all_proxy="${all_proxy:-${ALL_PROXY:-}}"
    local build_no_proxy="${no_proxy:-${NO_PROXY:-}}"
    build_http_proxy="$(rewrite_proxy_host "$build_http_proxy")"
    build_https_proxy="$(rewrite_proxy_host "$build_https_proxy")"
    build_all_proxy="$(rewrite_proxy_host "$build_all_proxy")"
    # Host scan-context trees and leftover core dumps are root-owned. Docker
    # still walks ignored paths and fails, so copy a filtered context first.
    local context_dir
    context_dir="$(mktemp -d /tmp/vulseek-release-context.XXXXXX)"
    trap 'rm -rf "$context_dir"' RETURN
    rsync -a \
        --exclude='.git/' \
        --exclude='.backup/' \
        --exclude='vulseek-data/' \
        --exclude='vulseek-data-dev/' \
        --exclude='vulseek-data-release/' \
        --exclude='node_modules/' \
        --exclude='apps/vulseek/node_modules/' \
        --exclude='apps/vulseek/.next/' \
        --exclude='apps/vulseek/core' \
        --exclude='packages/server/node_modules/' \
        --exclude='apps/api/node_modules.root-owned.20260707001805/' \
        --exclude='apps/schedules/node_modules.root-owned.20260707001805/' \
        --exclude='DockerSandboxes-linux-amd64/' \
        --exclude='DockerSandboxes-linux-amd64.tar.gz' \
        --exclude='third_party/raptor/' \
        "$SCRIPT_DIR/" "$context_dir/"
    docker build --progress=plain \
        --build-arg http_proxy="$build_http_proxy" \
        --build-arg https_proxy="$build_https_proxy" \
        --build-arg all_proxy="$build_all_proxy" \
        --build-arg no_proxy="$build_no_proxy" \
        --build-arg HTTP_PROXY="$build_http_proxy" \
        --build-arg HTTPS_PROXY="$build_https_proxy" \
        --build-arg ALL_PROXY="$build_all_proxy" \
        --build-arg NO_PROXY="$build_no_proxy" \
        -f "$context_dir/Dockerfile" \
        -t "$BUILD_IMAGE_NAME" \
        "$context_dir"
    echo -e "${GREEN}Release image built: ${BUILD_IMAGE_NAME}${NC}"
}

start_postgres() {
    if service_exists "$POSTGRES_SERVICE"; then
        echo -e "${YELLOW}PostgreSQL service already exists${NC}"
        return 0
    fi
    require_available_port "$POSTGRES_PORT" "$POSTGRES_SERVICE"
    docker service create \
        --name "$POSTGRES_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$POSTGRES_PORT",target=5432,mode=host \
        --env POSTGRES_USER=vulseek \
        --env POSTGRES_PASSWORD=vulseek_release_password \
        --env POSTGRES_DB=vulseek \
        --mount type=volume,source=postgres_release_data,target=/var/lib/postgresql/data \
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

start_redis() {
    if service_exists "$REDIS_SERVICE"; then
        echo -e "${YELLOW}Redis service already exists${NC}"
        return 0
    fi
    require_available_port "$REDIS_PORT" "$REDIS_SERVICE"
    docker service create \
        --name "$REDIS_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published="$REDIS_PORT",target=6379,mode=host \
        --mount type=volume,source=redis_release_data,target=/data \
        --health-cmd "redis-cli ping" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        redis:7
}

start_vulseek() {
    if service_exists "$VULSEEK_SERVICE"; then
        echo -e "${YELLOW}Vulseek release service already exists${NC}"
        return 0
    fi
    require_available_port "$VULSEEK_PORT" "$VULSEEK_SERVICE"
    check_env_file

    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    local effective_pipeline_definitions_host_path
    effective_pipeline_definitions_host_path="$(resolve_pipeline_definitions_host_path)"
    export VULSEEK_SCAN_CONTEXT_HOST_PATH="$effective_scan_context_host_path"

    pull_image

    local env_file_path="${SCRIPT_DIR}/${ENV_FILE}"
    local env_args=""
    while IFS= read -r line; do
        if [[ ! $line =~ ^[[:space:]]*# ]] && [[ -n $line ]]; then
            line=$(echo "$line" | sed 's/#.*$//' | xargs)
            if [[ -n $line ]]; then
                env_args="$env_args --env $line"
            fi
        fi
    done < "$env_file_path"

    eval docker service create \
        --name "$VULSEEK_SERVICE" \
        --network name="$NETWORK_NAME",alias=vulseek-release-login-test \
        --publish published="$VULSEEK_PORT",target=3000,mode=host \
        $env_args \
        --env NODE_ENV=production \
        --env RELEASE_TAG="$RELEASE_TAG" \
        --env VULSEEK_IMAGE_REPOSITORY="$IMAGE_REPOSITORY" \
        --env VULSEEK_SERVICE_NAME="$VULSEEK_SERVICE" \
        --env VULSEEK_TOOLS_IMAGE_VARIANT=release \
        --env VULSEEK_SCAN_CONTEXT_HOST_PATH="${effective_scan_context_host_path}" \
        --env VULSEEK_SCAN_CONTEXT_APP_PATH=/scan-context \
        --env VULSEEK_SCAN_PIPELINE_DEFINITIONS_PATH="${PIPELINE_DEFINITIONS_CONTAINER_PATH}" \
        --env VULSEEK_RESEARCH_DATABASE_URL="${VULSEEK_RESEARCH_DATABASE_URL:-postgresql://vulseek:vulseek_release_password@${POSTGRES_SERVICE}:5432/vulseek}" \
        --env DATABASE_URL=postgresql://vulseek:vulseek_release_password@"$POSTGRES_SERVICE":5432/vulseek \
        --env REDIS_URL=redis://"$REDIS_SERVICE":6379 \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
        --mount type=bind,source="${effective_scan_context_host_path}",target=/scan-context \
        --mount type=bind,source="${effective_pipeline_definitions_host_path}",target="${PIPELINE_DEFINITIONS_CONTAINER_PATH}",readonly \
        --mount type=volume,source=vulseek_release_data,target=/etc/vulseek \
        --mount type=volume,source=traefik_release_data,target=/etc/traefik \
        --mount type=volume,source=docker_release_config,target=/root/.docker \
        --constraint "'node.role==manager'" \
        "$IMAGE_NAME"
}

start_traefik() {
    if service_exists "$TRAEFIK_SERVICE"; then
        echo -e "${YELLOW}Traefik service already exists${NC}"
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
        --mount type=volume,source=traefik_release_data,target=/etc/traefik \
        --constraint 'node.role==manager' \
        traefik:v3.5.0 \
        --api.insecure=true \
        --api.dashboard=true \
        --providers.swarm=true \
        --providers.swarm.endpoint=unix:///var/run/docker.sock \
        --providers.swarm.exposedbydefault=false \
        --providers.swarm.network="$NETWORK_NAME" \
        --entrypoints.web.address=:80 \
        --log.level=INFO \
        --accesslog=true
}

start_all() {
    init_swarm
    preflight_ports
    start_postgres
    wait_for_service_healthy "$POSTGRES_SERVICE"
    start_redis
    wait_for_service_healthy "$REDIS_SERVICE"
    start_vulseek
    start_traefik
    show_status
}

stop_all() {
    docker service rm "$VULSEEK_SERVICE" 2>/dev/null || true
    docker service rm "$TRAEFIK_SERVICE" 2>/dev/null || true
    docker service rm "$REDIS_SERVICE" 2>/dev/null || true
    docker service rm "$POSTGRES_SERVICE" 2>/dev/null || true
    echo -e "${GREEN}Release environment stopped${NC}"
}

restart_vulseek() {
    docker service update --force --image "$IMAGE_NAME" "$VULSEEK_SERVICE"
}

show_logs() {
    local service_name
    service_name=$(resolve_service_name "${1:-vulseek}")

    local task_id
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    if [ -z "$task_id" ]; then
        echo -e "${RED}Service is not running: $service_name${NC}"
        return 1
    fi

    local container_id
    container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
    docker logs -f "$container_id"
}

show_status() {
    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    echo -e "${BLUE}Release image:${NC} ${IMAGE_NAME}"
    echo -e "${BLUE}Main app:${NC}      http://localhost:${VULSEEK_PORT}"
    echo -e "${BLUE}Traefik:${NC}       http://localhost:${TRAEFIK_DASHBOARD_PORT}"
    echo -e "${BLUE}PostgreSQL:${NC}    localhost:${POSTGRES_PORT}"
    echo -e "${BLUE}Redis:${NC}         localhost:${REDIS_PORT}"
    echo -e "${BLUE}Scan Context:${NC}  ${effective_scan_context_host_path}"
    list_environment_services
}

clean_all() {
    stop_all
    docker network rm "$NETWORK_NAME" 2>/dev/null || true
    docker volume rm vulseek_release_data docker_release_config postgres_release_data redis_release_data traefik_release_data 2>/dev/null || true
    echo -e "${GREEN}Release volumes removed${NC}"
}

COMMAND=""
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --scan-context-host-path)
            SCAN_CONTEXT_HOST_PATH="$2"
            shift 2
            ;;
        --scan-context-host-path=*)
            SCAN_CONTEXT_HOST_PATH="${1#*=}"
            shift
            ;;
        *)
            if [ -z "$COMMAND" ]; then
                COMMAND="$1"
            else
                ARGS+=("$1")
            fi
            shift
            ;;
    esac
done

case "${COMMAND:-help}" in
    init) init_swarm ;;
    build) build_image ;;
    pull) pull_image ;;
    start) start_all ;;
    stop) stop_all ;;
    restart) restart_vulseek ;;
    logs) show_logs "${ARGS[0]}" ;;
    ps) list_environment_services ;;
    status) show_status ;;
    clean) clean_all ;;
    help|--help|-h) show_help ;;
    *)
        echo -e "${RED}Unknown command: ${COMMAND}${NC}"
        show_help
        exit 1
        ;;
esac
