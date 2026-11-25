use crate::config::{Config, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    ConnectOptions, Connection, PgConnection, PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{str::FromStr, time::Duration};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const BASELINE: &str = include_str!("../../../schema/postgres-105.sql");

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("database configuration is invalid")]
    Configuration,
    #[error("database schema belongs to another environment or version")]
    Identity,
    #[error("an environment instance already owns this schema")]
    Owner,
    #[error("command identifier was already used for another operation")]
    CommandReuse,
}

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
    schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub project_id: String,
    pub title: String,
    pub workspace_root: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProject {
    pub command_id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub command_id: Uuid,
    pub project_id: Uuid,
    pub sequence: i64,
    pub duplicate: bool,
}

impl Database {
    pub async fn connect(config: &Config) -> Result<(Self, PgConnection), StorageError> {
        config.validate().map_err(|_| StorageError::Configuration)?;
        let path = format!("\"{}\",pg_catalog", config.schema);
        let options = PgConnectOptions::from_str(config.database_url.expose())
            .map_err(|_| StorageError::Configuration)?
            .application_name("stardust-rust-preview")
            .options([
                ("search_path", path.as_str()),
                ("timezone", "UTC"),
                ("synchronous_commit", "on"),
                ("statement_timeout", "30000"),
                ("lock_timeout", "10000"),
            ])
            .disable_statement_logging();
        let mut owner = PgConnection::connect_with(&options).await?;
        let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1), 2)")
            .bind(&config.schema)
            .fetch_one(&mut owner)
            .await?;
        if !acquired {
            return Err(StorageError::Owner);
        }
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options)
            .await?;
        let database = Self {
            pool,
            schema: config.schema.clone(),
        };
        database.initialize(&config.environment_id).await?;
        Ok((database, owner))
    }

    async fn initialize(&self, identity: &str) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        // Extensions are shared by schemas; IF NOT EXISTS alone races on an empty database.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('stardust-pg-extensions'), 0)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), 0)")
            .bind(&self.schema)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS \"{}\"", self.schema))
            .execute(&mut *tx)
            .await?;
        let metadata: Option<String> =
            sqlx::query_scalar("SELECT to_regclass('stardust_storage_metadata')::text")
                .fetch_one(&mut *tx)
                .await?;
        if metadata.is_none() {
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM pg_tables WHERE schemaname = $1")
                    .bind(&self.schema)
                    .fetch_one(&mut *tx)
                    .await?;
            if count != 0 {
                return Err(StorageError::Identity);
            }
            sqlx::raw_sql(BASELINE).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO stardust_storage_metadata (singleton, version, sqlite_migration, environment_id, status) VALUES (1,1,105,$1,'ready')")
                .bind(identity).execute(&mut *tx).await?;
        }
        let row = sqlx::query("SELECT version, sqlite_migration, environment_id, status FROM stardust_storage_metadata WHERE singleton=1").fetch_one(&mut *tx).await?;
        if row.try_get::<i32, _>("version")? != 1
            || row.try_get::<i32, _>("sqlite_migration")? != 105
            || row.try_get::<String, _>("environment_id")? != identity
            || row.try_get::<String, _>("status")? != "ready"
        {
            return Err(StorageError::Identity);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn projects(&self) -> Result<Vec<Project>, StorageError> {
        Ok(sqlx::query_as("SELECT project_id, title, workspace_root, created_at, updated_at FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id LIMIT 1000").fetch_all(&self.pool).await?)
    }

    pub async fn create_project(&self, input: &CreateProject) -> Result<Receipt, StorageError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), 1)")
            .bind(&self.schema)
            .execute(&mut *tx)
            .await?;
        let command = input.command_id.to_string();
        let project = input.project_id.to_string();
        if let Some(row) = sqlx::query("SELECT aggregate_id, command_type, result_sequence FROM orchestration_command_receipts WHERE command_id=$1").bind(&command).fetch_optional(&mut *tx).await? {
            if row.try_get::<String,_>("aggregate_id")? != project || row.try_get::<String,_>("command_type")? != "project.create" { return Err(StorageError::CommandReuse); }
            return Ok(Receipt {command_id: input.command_id, project_id: input.project_id, sequence: row.try_get("result_sequence")?, duplicate: true});
        }
        let now: String = sqlx::query_scalar("SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')").fetch_one(&mut *tx).await?;
        let payload = json!({"projectId":project,"title":input.title,"workspaceRoot":input.workspace_root,"defaultModelSelection":null,"scripts":[],"createdAt":now,"updatedAt":now});
        let sequence: i64 = sqlx::query_scalar("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES ($1,'project',$2,COALESCE((SELECT MAX(stream_version)+1 FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=$2),0),'project.created',$3,$4,$4,'client',$5,'{}',2) RETURNING sequence")
            .bind(Uuid::new_v4().to_string()).bind(&project).bind(&now).bind(&command).bind(payload.to_string()).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ($1,$2,$3,'[]',$4,$4)")
            .bind(&project).bind(&input.title).bind(&input.workspace_root).bind(&now).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,command_type) VALUES ($1,'project',$2,$3,$4,'applied','project.create')")
            .bind(&command).bind(&project).bind(&now).bind(sequence).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Receipt {
            command_id: input.command_id,
            project_id: input.project_id,
            sequence,
            duplicate: false,
        })
    }

    pub async fn events(&self, after: i64) -> Result<Vec<Value>, StorageError> {
        let rows = sqlx::query("SELECT sequence,event_id,stream_id,event_type,payload_json FROM orchestration_events WHERE sequence>$1 AND application_event_version=2 ORDER BY sequence LIMIT 500").bind(after).fetch_all(&self.pool).await?;
        rows.into_iter().map(|row| {
            let payload: String = row.try_get("payload_json")?;
            Ok(json!({"sequence":row.try_get::<i64,_>("sequence")?,"eventId":row.try_get::<String,_>("event_id")?,"streamId":row.try_get::<String,_>("stream_id")?,"type":row.try_get::<String,_>("event_type")?,"payload":serde_json::from_str::<Value>(&payload).map_err(|_| StorageError::Identity)?}))
        }).collect()
    }

    pub async fn health(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

pub async fn supervise_owner(mut owner: PgConnection, shutdown: CancellationToken) {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            result = tokio::time::timeout(Duration::from_secs(5), sqlx::query("SELECT 1").execute(&mut owner)) => {
                if !matches!(result, Ok(Ok(_))) {
                    tracing::error!("PostgreSQL ownership connection lost; stopping native runtime");
                    shutdown.cancel();
                    break;
                }
            }
        }
        tokio::select! { _ = shutdown.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
    }
}

#[derive(Clone)]
pub struct Cache {
    url: Option<Secret>,
    namespace: String,
    manager: std::sync::Arc<tokio::sync::Mutex<Option<redis::aio::ConnectionManager>>>,
}
impl Cache {
    pub fn new(config: &Config) -> Self {
        Self {
            url: config.redis_url.clone(),
            namespace: format!(
                "stardust-rust:{}:{}:{}",
                config.schema,
                config.environment_id,
                Uuid::new_v4()
            ),
            manager: Default::default(),
        }
    }
    async fn connection(&self) -> Option<redis::aio::ConnectionManager> {
        let url = self.url.as_ref()?;
        let mut slot = self.manager.lock().await;
        if let Some(value) = slot.as_ref() {
            return Some(value.clone());
        }
        let client = redis::Client::open(url.expose()).ok()?;
        let connection =
            tokio::time::timeout(Duration::from_secs(2), client.get_connection_manager())
                .await
                .ok()?
                .ok()?;
        *slot = Some(connection.clone());
        Some(connection)
    }
    pub async fn available(&self) -> bool {
        let Some(mut connection) = self.connection().await else {
            return false;
        };
        matches!(tokio::time::timeout(Duration::from_secs(2), redis::cmd("PING").query_async::<String>(&mut connection)).await, Ok(Ok(value)) if value == "PONG")
    }
    pub async fn get(&self, key: &str) -> Option<String> {
        let mut connection = self.connection().await?;
        tokio::time::timeout(
            Duration::from_secs(2),
            redis::cmd("GET")
                .arg(format!("{}:{key}", self.namespace))
                .query_async::<Option<String>>(&mut connection),
        )
        .await
        .ok()?
        .ok()?
    }
    pub async fn set(&self, key: &str, value: &str, ttl: u64) {
        if !(1..=90).contains(&ttl) {
            return;
        }
        let Some(mut connection) = self.connection().await else {
            return;
        };
        if value.len() > 1024 * 1024 {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                redis::cmd("UNLINK")
                    .arg(format!("{}:{key}", self.namespace))
                    .query_async::<()>(&mut connection),
            )
            .await;
            return;
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            redis::cmd("SET")
                .arg(format!("{}:{key}", self.namespace))
                .arg(value)
                .arg("EX")
                .arg(ttl)
                .query_async::<()>(&mut connection),
        )
        .await;
    }
}
