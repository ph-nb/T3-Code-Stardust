#![cfg(feature = "integration")]

use sqlx::Connection;
use stardust_runtime::{
    api::NativeServer,
    config::{Config, Secret},
    storage::{Cache, CreateProject, Database, StorageError, supervise_owner},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn configuration(directory: &tempfile::TempDir) -> Config {
    Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        data_dir: directory.path().to_path_buf(),
        frontend_dir: None,
        database_url: Secret::new(
            std::env::var("STARDUST_TEST_POSTGRES_URL").expect("isolated PostgreSQL URL required"),
        ),
        redis_url: Some(Secret::new(
            std::env::var("STARDUST_TEST_REDIS_URL").expect("isolated Redis URL required"),
        )),
        schema: format!("stardust_rust_test_{}", Uuid::new_v4().simple()),
        token: Secret::new("fixture-only-token-at-least-32-characters".to_owned()),
        environment_id: Uuid::new_v4().to_string(),
    }
}

#[tokio::test]
async fn preserves_deduplication_rollback_and_environment_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let config = configuration(&directory);
    config.validate().unwrap();
    let (database, mut owner) = Database::connect(&config).await.unwrap();
    assert!(matches!(
        Database::connect(&config).await,
        Err(StorageError::Owner)
    ));
    let input = CreateProject {
        command_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        title: "Rust 中文项目".into(),
        workspace_root: "/fixture".into(),
    };
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let database = database.clone();
        let input = input.clone();
        tasks.spawn(async move { database.create_project(&input).await.unwrap() });
    }
    let mut receipts = Vec::new();
    while let Some(result) = tasks.join_next().await {
        receipts.push(result.unwrap());
    }
    assert_eq!(
        receipts.iter().filter(|receipt| !receipt.duplicate).count(),
        1
    );
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.sequence == receipts[0].sequence)
    );
    assert_eq!(database.projects().await.unwrap().len(), 1);
    assert_eq!(database.events(0).await.unwrap().len(), 1);
    let conflict = CreateProject {
        command_id: Uuid::new_v4(),
        ..input.clone()
    };
    assert!(database.create_project(&conflict).await.is_err());
    assert_eq!(database.events(0).await.unwrap().len(), 1);
    let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orchestration_command_receipts")
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(receipts, 1);
    sqlx::query("SELECT pg_advisory_unlock(hashtext($1), 2)")
        .bind(&config.schema)
        .execute(&mut owner)
        .await
        .unwrap();
    owner.close().await.unwrap();
    let mut unrelated = config.clone();
    unrelated.environment_id = "another-environment".into();
    assert!(matches!(
        Database::connect(&unrelated).await,
        Err(StorageError::Identity)
    ));
    sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", config.schema))
        .execute(database.pool())
        .await
        .unwrap();
    database.pool().close().await;
}

#[tokio::test]
async fn native_http_rejects_missing_credentials_and_does_not_advertise_client_compatibility() {
    let directory = tempfile::tempdir().unwrap();
    let config = configuration(&directory);
    let server = NativeServer::bind(config.clone()).await.unwrap();
    let address = server.address;
    let shutdown = server.shutdown.clone();
    let running = tokio::spawn(server.run());
    let request = |path: &'static str, token: Option<String>| async move {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let header = token
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        socket
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{header}\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    };
    let denied = request("/api/native/v1/projects", None).await;
    assert!(denied.starts_with("HTTP/1.1 401"));
    let accepted = request(
        "/api/native/v1/capabilities",
        Some(config.token.expose().to_owned()),
    )
    .await;
    assert!(accepted.starts_with("HTTP/1.1 200"));
    assert!(accepted.contains("\"clientProtocolCompatible\":false"));
    shutdown.cancel();
    running.await.unwrap().unwrap();
    let (database, owner) = Database::connect(&config).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", config.schema))
        .execute(database.pool())
        .await
        .unwrap();
    drop(owner);
    database.pool().close().await;
}

#[tokio::test]
async fn redis_is_disposable_and_ownership_loss_stops_admission() {
    let directory = tempfile::tempdir().unwrap();
    let config = configuration(&directory);
    let (database, mut owner) = Database::connect(&config).await.unwrap();
    let cache = Cache::new(&config);
    assert!(cache.available().await);
    cache.set("fixture", "中文缓存", 60).await;
    assert_eq!(cache.get("fixture").await.as_deref(), Some("中文缓存"));
    cache.set("fixture", &"x".repeat(1024 * 1024 + 1), 60).await;
    assert!(cache.get("fixture").await.is_none());
    cache
        .set("oversize", &"x".repeat(1024 * 1024 + 1), 60)
        .await;
    assert!(cache.get("oversize").await.is_none());
    let mut unavailable = config.clone();
    unavailable.redis_url = Some(Secret::new("redis://127.0.0.1:1".into()));
    assert!(!Cache::new(&unavailable).available().await);
    assert!(database.health().await);
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut owner)
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let monitor = tokio::spawn(supervise_owner(owner, shutdown.clone()));
    sqlx::query("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .execute(database.pool())
        .await
        .unwrap();
    shutdown.cancelled().await;
    monitor.await.unwrap();
    sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", config.schema))
        .execute(database.pool())
        .await
        .unwrap();
    database.pool().close().await;
}
