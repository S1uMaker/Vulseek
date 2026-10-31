# Vulseek 开发环境端口映射

本文档说明 Vulseek 开发环境中所有服务的端口映射关系。

## 📊 端口映射表

所有外部暴露的端口都在 **20000-29999** 范围内，避免与常见服务冲突。

| 服务 | 宿主机端口 | → | 容器端口 | 用途 | 访问地址 |
|------|-----------|---|---------|------|---------|
| **vulseek-dev** | 23000 | → | 3000 | 主应用 | http://localhost:23000 |
| **vulseek-dev** | 29229 | → | 9229 | Node.js 调试 | localhost:29229 |
| **vulseek-dev** | 25555 | → | 5555 | 数据库管理 (Drizzle Studio) | http://localhost:25555 |
| **postgres** | 25432 | → | 5432 | PostgreSQL 数据库 | localhost:25432 |
| **redis** | 26379 | → | 6379 | Redis 缓存 | localhost:26379 |
| **traefik** | 20080 | → | 80 | HTTP 反向代理 | http://localhost:20080 |
| **traefik** | 28080 | → | 8080 | Traefik Dashboard | http://localhost:28080 |

Release 环境使用独立的 `3xxxx` 端口：

| 服务 | 宿主机端口 | 容器端口 | 覆盖变量 |
|------|-----------:|---------:|----------|
| **vulseek-release** | 33000 | 3000 | `VULSEEK_RELEASE_PORT` |
| **postgres-release** | 35432 | 5432 | `POSTGRES_RELEASE_PORT` |
| **redis-release** | 36379 | 6379 | `REDIS_RELEASE_PORT` |
| **traefik-release HTTP** | 30080 | 80 | `TRAEFIK_RELEASE_HTTP_PORT` |
| **traefik-release Dashboard** | 38080 | 8080 | `TRAEFIK_RELEASE_DASHBOARD_PORT` |

## 🔍 端口说明

### 主应用 (23000)
- **用途**: Vulseek Web 界面和 API
- **协议**: HTTP
- **访问**: http://localhost:23000
- **容器内**: 应用监听 3000 端口

### Node.js 调试端口 (29229)
- **用途**: Node.js Inspector 调试协议
- **协议**: WebSocket
- **工具**: VS Code、Chrome DevTools
- **配置**: 在 VS Code 的 `launch.json` 中使用此端口

### 数据库管理 (25555)
- **用途**: Drizzle Studio 或其他数据库管理工具
- **协议**: HTTP
- **访问**: http://localhost:25555
- **说明**: 需要手动启动 `./dev.sh db:studio`

### PostgreSQL (25432)
- **用途**: PostgreSQL 数据库连接
- **协议**: PostgreSQL Wire Protocol
- **连接信息**:
  ```
  Host: localhost
  Port: 25432
  Database: vulseek
  Username: vulseek
  Password: vulseek_dev_password
  ```
- **连接字符串**: `postgresql://vulseek:vulseek_dev_password@localhost:25432/vulseek`

### Redis (26379)
- **用途**: Redis 缓存和消息队列
- **协议**: Redis Protocol (RESP)
- **连接**: `redis://localhost:26379`
- **命令行**: `./dev.sh redis` 或 `redis-cli -p 26379`

### Traefik HTTP (20080)
- **用途**: HTTP 流量入口
- **协议**: HTTP
- **说明**: 用于测试反向代理和路由规则

### Traefik Dashboard (28080)
- **用途**: Traefik 管理面板
- **协议**: HTTP
- **访问**: http://localhost:28080
- **功能**: 查看路由、中间件、服务状态等

## 🔧 修改端口

如果端口冲突，可以在运行 `dev.sh` 时覆盖环境变量：

```bash
VULSEEK_DEV_PORT=23001 \
POSTGRES_DEV_PORT=25433 \
REDIS_DEV_PORT=26380 \
TRAEFIK_DEV_HTTP_PORT=20081 \
TRAEFIK_DEV_DASHBOARD_PORT=28081 \
NODE_DEBUG_DEV_PORT=29230 \
DRIZZLE_STUDIO_DEV_PORT=25556 \
./dev.sh start
```

**注意**: 修改端口后需要：
1. 停止后使用相同的环境变量重新启动: `./dev.sh stop && ./dev.sh start`
2. 更新环境变量中的连接字符串
3. 更新 VS Code 调试配置

## 🐛 端口检查

### 检查端口是否被占用

```bash
# Linux/Mac
lsof -i :23000
lsof -i :25432
lsof -i :26379
lsof -i :20080
lsof -i :28080
lsof -i :29229
lsof -i :25555

# 或使用 netstat
netstat -tuln | grep -E '(23000|25432|26379|20080|28080|29229|25555)'
```

### 查看所有监听端口

```bash
# 查看 Docker 容器端口映射
docker ps --format "table {{.Names}}\t{{.Ports}}"

# 或使用 dev.sh
./dev.sh status
```

## 🌐 容器间通信

容器内部通信使用容器端口和服务名：

```bash
# 在 vulseek-dev 容器内访问其他服务
DATABASE_URL=postgresql://vulseek:vulseek_dev_password@postgres:5432/vulseek
REDIS_URL=redis://redis:6379
```

**重要**: 
- 宿主机访问容器：使用宿主机端口 (23000, 25432, 等)
- 容器间通信：使用服务名和容器端口 (postgres:5432, redis:6379)

## 📝 环境变量

在 `.env.development` 中配置：

```bash
# 容器内使用
DATABASE_URL=postgresql://vulseek:vulseek_dev_password@postgres:5432/vulseek
REDIS_URL=redis://redis:6379

# 从宿主机访问（如果需要）
# DATABASE_URL=postgresql://vulseek:vulseek_dev_password@localhost:25432/vulseek
# REDIS_URL=redis://localhost:26379
```

## 🔒 安全说明

### 开发环境
- ✅ 仅监听 localhost，不暴露到外网
- ✅ 使用开发用密码（vulseek_dev_password）
- ✅ 调试端口仅在开发环境启用

### 生产环境
- ⚠️ 不要在生产环境使用这些端口配置
- ⚠️ 不要暴露调试端口到公网
- ⚠️ 使用强密码和环境变量

## 🚀 快速访问

启动环境后，常用访问地址：

```bash
# Web 界面
open http://localhost:23000

# Traefik 面板
open http://localhost:28080

# 数据库客户端
psql postgresql://vulseek:vulseek_dev_password@localhost:25432/vulseek

# Redis 命令行
redis-cli -p 26379

# 或使用便捷脚本
./dev.sh status  # 查看所有服务状态和访问地址
```

## 📚 相关文档

- [快速开始](./QUICKSTART.dev.md)
- [完整开发文档](./DEVELOPMENT.md)

---

**提示**: 使用 `./dev.sh status` 可以随时查看所有服务的端口和访问地址。
