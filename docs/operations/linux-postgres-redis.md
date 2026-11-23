# Linux 单实例服务端：PostgreSQL + Redis

Linux 独立服务端通过 `T3CODE_DATABASE_BACKEND=postgres` 启用 PostgreSQL，Redis 用作可丢弃缓存。桌面内置服务默认继续使用 SQLite。显式选择 PostgreSQL 后，数据库故障会返回错误，服务不会自动切回 SQLite。

## 数据职责

| 内容                                             | 存放位置              | 恢复方式                                 |
| ------------------------------------------------ | --------------------- | ---------------------------------------- |
| 聊天事件、项目、线程投影、命令去重回执           | PostgreSQL            | 数据库备份；投影可按事件重建             |
| outbox、定时任务、Webhook 去重和待执行状态       | PostgreSQL            | 事务提交；保留原有进程丢失恢复规则       |
| 配对、会话、访问授权、Provider 会话元数据        | PostgreSQL            | 数据库备份与环境密钥共同恢复             |
| PR 等外部读取结果、失效版本                      | 进程内有界 L1 + Redis | 缓存丢失时回源；成功结果有效期最多 60 秒 |
| Git 状态、解析文档、搜索工作集                   | 当前进程内有界缓存    | 重新读取当前文件和数据库                 |
| 附件、产物、仓库、worktree、日志、加密密钥和设置 | 原有环境文件目录      | 文件备份；需与数据库一起保留             |
| PTY、Provider 子进程、连接句柄                   | 当前服务进程          | 按原恢复规则重新建立，不能从 Redis 还原  |

一个 schema 绑定一个持久化环境 ID。服务使用独立 PostgreSQL 会话锁限制活动实例，锁连接丢失时停止当前运行环境。原有 `server-owner.sqlite` 只保留为本机进程的 OS 所有权锁，不保存业务数据；它同时阻止迁移和服务争用同一个 T3 home。不要删除正在使用的锁文件。

本版本采用单个活动服务实例。PostgreSQL 写事务在检查回执、分配版本和事件序号前取得事务锁，从而保持游标与提交顺序一致。事件、投影、回执和 outbox 一起提交，Provider 等外部工作在提交后执行。队列抢占使用数据库条件更新和行锁。Redis 不承担唯一队列、鉴权真相或正确性锁。

Redis key 包含环境 ID 的哈希及启动代号，清理只作用于当前命名空间。单条缓存默认最多 1 MiB，Redis TTL 默认最多 90 秒并有抖动；业务结果自身最多 60 秒。Redis 失效写入超时时会切换缓存代号，旧结果无法再次命中；连接恢复后继续缓存。每次重启从新的缓存空间开始，旧 key 自行过期。没有配置 Redis 时使用有界 L1。其他领域缓存按表中职责保留在进程内，暂不复制到 Redis。

## 准备服务

`infra/server-storage/compose.yaml` 提供 PostgreSQL 17 和 Redis 8.2。PostgreSQL 保存到独立 volume，Redis 使用 256 MiB 的 `allkeys-lfu` 内存淘汰策略并关闭持久化。两者仅映射到本机回环地址。T3 和 Provider CLI 仍运行在 Linux 主机上。

1. 在 `infra/server-storage` 复制 `.env.example` 为 `.env`，填入三个独立密码。使用 `openssl rand -hex 32` 生成的十六进制密码可以直接用于示例连接 URL。
2. 执行 `docker compose up -d`，再用 `docker compose ps` 检查健康状态。初始化脚本创建非超级用户 `stardust`，数据库也由它拥有。目标 PostgreSQL 需要 UTF-8 编码和 `pg_trgm` 扩展；数据库 owner 可以安装这个受信任扩展。
3. 按 `service.env.example` 准备环境变量。后台服务读取 `<T3 home>/service.env`；该文件应为 `0600`。手动执行 CLI 时，从同一文件加载环境，避免把连接密码写进命令参数和 shell 历史。

例如，手动加载已经保护好的环境文件：

```sh
set -a
. /absolute/path/to/t3-home/service.env
set +a
```

`T3CODE_DATABASE_BACKEND` 默认 `auto`：有数据库 URL 时选择 PostgreSQL，否则选择 SQLite，方便本地开发。Linux 部署应明确写 `postgres`，让配置缺失直接报错。`T3CODE_POSTGRES_SCHEMA` 默认 `stardust`，连接池默认 8。分别部署多个环境时使用不同 schema 和各自的 T3 home，保留原有环境 ID。

## 迁移已有 SQLite

先停止原服务、Provider 工作和其他会写入该环境的 CLI。确认当前二进制包含本次改造；已有业务库不能直接改连接 URL 后启动。

在切换前备份完整 T3 home、环境密钥以及外置仓库、worktree、附件目录。迁移命令自动备份业务数据库，文件资产仍由运维备份负责。

```sh
t3 storage migrate-postgres --base-dir /absolute/path/to/t3-home
```

该命令会：

1. 获取本机所有权锁和目标 PostgreSQL 环境锁，拒绝与运行服务并行执行。
2. 用 SQLite 在线备份 API 从只读源生成一致性回滚副本，检查完整性和外键，计算 SHA-256。
3. 在独立 staging 副本上补齐 SQLite 迁移到 105，原数据库和回滚副本保持不变。
4. 检查目标 schema 为空，然后在一个事务中导入全部 48 张业务表，保留行标识、事件序号和 JSON 文本编码；不复制 SQLite 内部表或 FTS 影子表。
5. 按固定顺序逐表核对行数和全部字段的内容哈希，保留事件序列高水位（包括已清理事件的序号），验证通过后标记目标可用。
6. 输出 `statev2-before-postgres-<id>.sqlite` 和 `.manifest.json` 的绝对路径。失败时回滚目标数据，保留源、副本和 staging 文件用于排查；修复源数据后可重试空目标。

目标非空或已经导入过时会拒绝，不会清库。使用相同环境变量和 T3 home 启动服务，核对已有项目、聊天、附件、任务和配对。客户端继续使用现有 WebSocket/API，无需重新导入到 Windows、Android 或其他客户端。

## 维护与回滚

存储状态页显示 PostgreSQL 所在数据库的总空间；多个 schema 共用数据库时，这个数字包含其他 schema。后台统计使用数据库总量，避免逐表取锁影响 DDL。`t3 doctor --base-dir ...` 查询当前 schema 的空间和估算死元组；`--fix` 执行普通 `VACUUM (ANALYZE)`。日常由 autovacuum 管理空闲空间，不会对保留的 SQLite 回滚库执行清理，也不会自动执行阻塞性的 `VACUUM FULL`。

日常备份使用 `pg_dump -Fc`，同时备份文件资产、环境 ID、设置和密钥；大库可另外规划 PostgreSQL WAL 归档和时间点恢复。Redis 无需数据备份。恢复演练应在独立数据库和文件目录验证。

PostgreSQL 尚未接收新写入时，可以停止新服务、恢复原服务配置和经过校验的 SQLite 副本。PostgreSQL 接收新写入之后，直接切回旧 SQLite 会丢失这段时间的数据；应先导出和对账，或明确恢复到切换时刻。当前命令只提供 SQLite 到 PostgreSQL 的导入，不提供自动反向合并。

## 验证

设置 `STARDUST_TEST_POSTGRES_URL` 和 `STARDUST_TEST_REDIS_URL` 指向独立测试实例，在 `apps/server` 执行 `vp run test:storage`。测试会创建和删除自己的 PostgreSQL schema，并仅清理自己的 Redis 前缀。测试需要能安装 `pg_trgm`、查看自己的会话锁和终止自己的测试连接。

该套件覆盖提交顺序、只读快照、并发命令去重、outbox 抢占和回滚、JSON 数组保留、配对消费、中文等多语言检索、计数触发器、所有权连接中断、旧版对话导入、后台清理、存储容量状态、迁移失败重试、逐表校验、SQLite 恢复，以及 Redis 隔离、大小、TTL 和超时回源。
