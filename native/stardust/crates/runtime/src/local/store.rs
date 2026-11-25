use serde_json::{Value, json};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::path::Path;
use uuid::Uuid;

#[derive(Clone)]
pub struct LocalStore {
    pool: SqlitePool,
    pub environment_id: String,
}

impl LocalStore {
    pub async fn open(directory: &Path) -> Result<Self, sqlx::Error> {
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(sqlx::Error::Io)?;
        let options = SqliteConnectOptions::new()
            .filename(directory.join("local.sqlite"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await?;
        sqlx::query("INSERT OR IGNORE INTO local_meta(key, value) VALUES('environment_id', ?)")
            .bind(Uuid::new_v4().to_string())
            .execute(&pool)
            .await?;
        let environment_id =
            sqlx::query_scalar("SELECT value FROM local_meta WHERE key='environment_id'")
                .fetch_one(&pool)
                .await?;
        Ok(Self {
            pool,
            environment_id,
        })
    }

    pub async fn sequence(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM local_events")
            .fetch_one(&self.pool)
            .await
    }

    pub async fn read(&self, kind: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT body FROM local_documents WHERE kind=? AND id=?")
                .bind(kind)
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        value
            .map(|body| {
                serde_json::from_str(&body).map_err(|error| sqlx::Error::Decode(error.into()))
            })
            .transpose()
    }

    pub async fn list(&self, kind: &str, parent: Option<&str>) -> Result<Vec<Value>, sqlx::Error> {
        let rows = sqlx::query("SELECT body FROM local_documents WHERE kind=? AND (? IS NULL OR parent_id=?) ORDER BY ordinal,id")
            .bind(kind).bind(parent).bind(parent).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                let body: String = row.try_get("body")?;
                serde_json::from_str(&body).map_err(|error| sqlx::Error::Decode(error.into()))
            })
            .collect()
    }

    pub async fn receipt(&self, command_id: &str) -> Result<Option<Value>, sqlx::Error> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT result FROM local_receipts WHERE command_id=?")
                .bind(command_id)
                .fetch_optional(&self.pool)
                .await?;
        value
            .map(|body| {
                serde_json::from_str(&body).map_err(|error| sqlx::Error::Decode(error.into()))
            })
            .transpose()
    }

    pub async fn commit(
        &self,
        command_id: &str,
        documents: &[Document],
        event: &Value,
    ) -> Result<Value, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        if let Some(body) =
            sqlx::query_scalar::<_, String>("SELECT result FROM local_receipts WHERE command_id=?")
                .bind(command_id)
                .fetch_optional(&mut *transaction)
                .await?
        {
            return serde_json::from_str(&body).map_err(|error| sqlx::Error::Decode(error.into()));
        }
        for document in documents {
            sqlx::query("INSERT INTO local_documents(kind,id,parent_id,ordinal,body) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=excluded.parent_id,ordinal=excluded.ordinal,body=excluded.body")
                .bind(&document.kind).bind(&document.id).bind(&document.parent_id).bind(document.ordinal)
                .bind(document.body.to_string()).execute(&mut *transaction).await?;
        }
        let sequence = sqlx::query("INSERT INTO local_events(body) VALUES(?)")
            .bind(event.to_string())
            .execute(&mut *transaction)
            .await?
            .last_insert_rowid();
        let result = json!({"sequence":sequence});
        sqlx::query("INSERT INTO local_receipts(command_id,result) VALUES(?,?)")
            .bind(command_id)
            .bind(result.to_string())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

pub struct Document {
    pub kind: String,
    pub id: String,
    pub parent_id: Option<String>,
    pub ordinal: i64,
    pub body: Value,
}

impl Document {
    pub fn new(kind: &str, id: &str, parent: Option<&str>, body: Value) -> Self {
        let ordinal = body.get("ordinal").and_then(Value::as_i64).unwrap_or(0);
        Self {
            kind: kind.to_owned(),
            id: id.to_owned(),
            parent_id: parent.map(str::to_owned),
            ordinal,
            body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomically_persists_commands_and_keeps_identity_after_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path()).await.unwrap();
        let identity = store.environment_id.clone();
        let documents = [Document::new(
            "project",
            "project-1",
            None,
            json!({"id":"project-1","title":"local"}),
        )];
        let first = store
            .commit("command-1", &documents, &json!({"type":"project.created"}))
            .await
            .unwrap();
        let changed = [Document::new(
            "project",
            "project-1",
            None,
            json!({"id":"project-1","title":"duplicate must not replace"}),
        )];
        assert_eq!(
            store
                .commit("command-1", &changed, &json!({}))
                .await
                .unwrap(),
            first
        );
        assert_eq!(store.sequence().await.unwrap(), 1);
        store.close().await;
        let reopened = LocalStore::open(directory.path()).await.unwrap();
        assert_eq!(identity, reopened.environment_id);
        assert_eq!(
            reopened
                .read("project", "project-1")
                .await
                .unwrap()
                .unwrap()["title"],
            "local"
        );
        assert_eq!(reopened.sequence().await.unwrap(), 1);
        assert_eq!(reopened.list("project", None).await.unwrap().len(), 1);
    }
}
