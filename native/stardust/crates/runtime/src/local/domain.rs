use super::{DEFAULTS, LocalStore, now, store::Document};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Missing(String),
    #[error("Native operation is not available: {0}")]
    Unsupported(String),
    #[error("Local storage operation failed")]
    Storage(#[from] sqlx::Error),
    #[error("Local filesystem operation failed")]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub(super) struct Change {
    pub sequence: i64,
    pub shell: Option<Value>,
    pub thread_id: Option<String>,
    pub event: Option<Value>,
    pub snapshot: bool,
    pub config: bool,
}

pub(super) struct Service {
    pub store: LocalStore,
    pub config: RwLock<Value>,
    pub changed: broadcast::Sender<Change>,
    pub write_gate: Mutex<()>,
    pub shutdown: CancellationToken,
    pub directory: PathBuf,
    pub running: Mutex<std::collections::HashMap<String, (String, CancellationToken)>>,
    pub auth_states: RwLock<std::collections::HashMap<String, Value>>,
    pub auth_tasks: Mutex<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>,
    pub responses: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    pub clients: std::sync::atomic::AtomicU64,
    pub config_acks: std::sync::atomic::AtomicU64,
    pub shell_acks: std::sync::atomic::AtomicU64,
    pub client_reports: std::sync::atomic::AtomicU64,
    pub idle_clients: Mutex<std::collections::HashMap<String, super::provider::BorrowClient>>,
}

pub(super) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| Error::Invalid(format!("Missing {key}")))
}

impl Service {
    pub async fn new(directory: PathBuf) -> Result<Arc<Self>, Error> {
        let store = LocalStore::open(&directory).await?;
        let mut config = DEFAULTS["config"].clone();
        config["environment"]["environmentId"] = json!(store.environment_id);
        config["environment"]["label"] =
            json!(std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Local computer".into()));
        config["environment"]["platform"]["os"] = json!(if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        });
        config["environment"]["serverVersion"] = json!(crate::RUNTIME_VERSION);
        let cwd = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.clone());
        config["cwd"] = json!(cwd);
        config["scratchWorkspaceRoot"] = json!(directory.join("scratch"));
        config["newProjectsRoot"] = json!(if std::env::var("STARDUST_TEST_REPLAY").as_deref()
            == Ok("1")
        {
            directory.join("projects")
        } else {
            cwd.join("Projects")
        });
        config["keybindingsConfigPath"] = json!(directory.join("keybindings.json"));
        config["observability"]["logsDirectoryPath"] = json!(directory.join("logs"));
        if let Some(settings) = store.read("settings", "server").await? {
            config["settings"] = settings;
        }
        let (changed, _) = broadcast::channel(256);
        let service = Arc::new(Self {
            store,
            config: RwLock::new(config),
            changed,
            write_gate: Mutex::new(()),
            shutdown: CancellationToken::new(),
            directory,
            running: Mutex::new(std::collections::HashMap::new()),
            auth_states: RwLock::new(std::collections::HashMap::new()),
            auth_tasks: Mutex::new(std::collections::HashMap::new()),
            responses: Mutex::new(std::collections::HashMap::new()),
            clients: std::sync::atomic::AtomicU64::new(0),
            config_acks: std::sync::atomic::AtomicU64::new(0),
            shell_acks: std::sync::atomic::AtomicU64::new(0),
            client_reports: std::sync::atomic::AtomicU64::new(0),
            idle_clients: Mutex::new(std::collections::HashMap::new()),
        });
        super::provider::recover(service.clone()).await?;
        Ok(service)
    }

    pub async fn shell(&self) -> Result<Value, Error> {
        let _guard = self.write_gate.lock().await;
        let threads = self.store.list("shell", None).await?;
        Ok(
            json!({"schemaVersion":1,"snapshotSequence":self.store.sequence().await?,
            "projects":self.store.list("project",None).await?.into_iter().filter(|p|p["deletedAt"].is_null()).collect::<Vec<_>>(),
            "threads":threads.iter().filter(|t|t["deletedAt"].is_null()&&t["archivedAt"].is_null()).collect::<Vec<_>>(),
            "archivedThreads":threads.iter().filter(|t|t["deletedAt"].is_null()&&!t["archivedAt"].is_null()).collect::<Vec<_>>() }),
        )
    }

    pub async fn projection(&self, id: &str) -> Result<Value, Error> {
        Ok(self.thread_snapshot(id).await?["projection"].clone())
    }

    pub async fn thread_snapshot(&self, id: &str) -> Result<Value, Error> {
        let _guard = self.write_gate.lock().await;
        Ok(
            json!({"snapshotSequence":self.store.sequence().await?,"projection":self.load_projection(id).await?}),
        )
    }

    async fn load_projection(&self, id: &str) -> Result<Value, Error> {
        let mut projection = DEFAULTS["projection"].clone();
        projection["thread"] = self
            .store
            .read("thread", id)
            .await?
            .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
        let items = self.store.list("item", Some(id)).await?;
        projection["runs"] = json!(self.store.list("run", Some(id)).await?);
        projection["runtimeRequests"] = json!(self.store.list("request", Some(id)).await?);
        projection["turnItems"] = json!(items);
        projection["visibleTurnItems"] = json!(items.iter().enumerate().map(|(position,item)|json!({
            "position":position,"visibility":"local","sourceThreadId":id,"sourceItemId":item["id"],"item":item
        })).collect::<Vec<_>>());
        projection["updatedAt"] = projection["thread"]["updatedAt"].clone();
        Ok(projection)
    }

    pub async fn project(self: &Arc<Self>, input: Value) -> Result<Value, Error> {
        let _guard = self.write_gate.lock().await;
        let command_id = string(&input, "commandId")?;
        let id = string(&input, "projectId")?;
        if self.store.receipt(command_id).await?.is_some() {
            return self
                .store
                .read("project", id)
                .await?
                .ok_or_else(|| Error::Missing("Unknown project".into()));
        }
        let timestamp = now();
        let mut project = match string(&input, "type")? {
            "project.create" => {
                if self.store.read("project", id).await?.is_some() {
                    return Err(Error::Invalid("Project already exists".into()));
                }
                let root = PathBuf::from(string(&input, "workspaceRoot")?);
                if input["createWorkspaceRootIfMissing"].as_bool() == Some(true) {
                    tokio::fs::create_dir_all(&root).await?;
                }
                if !root.is_dir() {
                    return Err(Error::Invalid(
                        "Choose an existing workspace directory".into(),
                    ));
                }
                json!({"id":id,"title":string(&input,"title")?,"workspaceRoot":root,"repositoryIdentity":null,
                    "defaultModelSelection":input.get("defaultModelSelection").cloned().unwrap_or(Value::Null),
                    "scripts":input.get("scripts").cloned().unwrap_or(json!([])),
                    "createdAt":timestamp,"updatedAt":timestamp,"deletedAt":null})
            }
            "project.update" | "project.delete" => self
                .store
                .read("project", id)
                .await?
                .ok_or_else(|| Error::Missing("Unknown project".into()))?,
            other => return Err(Error::Unsupported(other.into())),
        };
        if input["type"] == "project.delete" {
            project["deletedAt"] = json!(timestamp);
        } else {
            for key in [
                "title",
                "defaultModelSelection",
                "scripts",
                "projectIcon",
                "faviconPath",
                "defaultThreadEnvMode",
                "autoPull",
            ] {
                if let Some(value) = input.get(key) {
                    project[key] = value.clone();
                }
            }
        }
        project["updatedAt"] = json!(timestamp);
        let result = self
            .store
            .commit(
                command_id,
                &[Document::new("project", id, None, project.clone())],
                &json!({"type":"project.updated","projectId":id}),
            )
            .await?;
        let sequence = result["sequence"].as_i64().unwrap_or(0);
        let shell = if project["deletedAt"].is_null() {
            json!({"kind":"project.updated","sequence":sequence,"project":project})
        } else {
            json!({"kind":"project.removed","sequence":sequence,"projectId":id})
        };
        let _ = self.changed.send(Change {
            sequence,
            shell: Some(shell),
            thread_id: None,
            event: None,
            snapshot: false,
            config: false,
        });
        Ok(project)
    }

    pub async fn create_thread(self: &Arc<Self>, input: &Value) -> Result<Value, Error> {
        string(input, "title")?;
        string(&input["modelSelection"], "instanceId")?;
        string(&input["modelSelection"], "model")?;
        if input["workspaceStrategy"]["type"]
            .as_str()
            .is_some_and(|kind| kind != "root" && kind != "existing_worktree")
        {
            return Err(Error::Unsupported("native worktree creation".into()));
        }
        let command_id = string(input, "commandId")?;
        let id = input
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("thread-{command_id}"));
        let project_id = string(input, "projectId")?;
        let timestamp = now();
        {
            let _guard = self.write_gate.lock().await;
            if self.store.receipt(command_id).await?.is_none() {
                if self.store.read("project", project_id).await?.is_none() {
                    return Err(Error::Missing("Unknown project".into()));
                }
                let mut shell = DEFAULTS["threadShell"].clone();
                for (key, value) in [
                    ("id", json!(id)),
                    ("projectId", json!(project_id)),
                    ("title", input["title"].clone()),
                    ("modelSelection", input["modelSelection"].clone()),
                    (
                        "providerInstanceId",
                        input["modelSelection"]["instanceId"].clone(),
                    ),
                    ("createdAt", json!(timestamp)),
                    ("updatedAt", json!(timestamp)),
                    ("lastVisitedAt", json!(timestamp)),
                ] {
                    shell[key] = value;
                }
                shell["lineage"]["rootThreadId"] = json!(id);
                for key in ["runtimeMode", "interactionMode", "branch", "worktreePath"] {
                    if let Some(value) = input.get(key) {
                        shell[key] = value.clone();
                    }
                }
                if input["workspaceStrategy"]["type"] == "existing_worktree" {
                    shell["worktreePath"] = input["workspaceStrategy"]["worktreePath"].clone();
                }
                let mut thread = DEFAULTS["projection"]["thread"].clone();
                for (key, value) in thread.as_object_mut().expect("thread template").iter_mut() {
                    if let Some(source) = shell.get(key) {
                        *value = source.clone();
                    }
                }
                let result = self
                    .store
                    .commit(
                        command_id,
                        &[
                            Document::new("thread", &id, Some(project_id), thread),
                            Document::new("shell", &id, Some(project_id), shell.clone()),
                        ],
                        &json!({"type":"thread.created","threadId":id}),
                    )
                    .await?;
                let sequence = result["sequence"].as_i64().unwrap_or(0);
                let _=self.changed.send(Change {sequence,shell:Some(json!({"kind":"thread.updated","sequence":sequence,"location":"active","thread":shell})),thread_id:Some(id.clone()),event:None,snapshot:true,config:false});
            }
        }
        if let Some(message) = input.get("initialMessage") {
            Box::pin(self.dispatch(json!({"type":"message.dispatch","commandId":format!("{command_id}:initial"),"threadId":id,
                "messageId":message.get("messageId").cloned().unwrap_or(json!(Uuid::new_v4().to_string())),
                "text":message["text"],"attachments":message.get("attachments").cloned().unwrap_or(json!([])),
                "dispatchMode":{"type":"start_immediately"}}))).await?;
        }
        Ok(
            json!({"threadId":id,"projection":self.projection(&id).await?,"resumed":false,"sequence":self.store.sequence().await?}),
        )
    }

    pub async fn dispatch(self: &Arc<Self>, input: Value) -> Result<Value, Error> {
        if input["type"] == "runtime-request.respond" {
            return super::requests::answer(self.clone(), input).await;
        }
        if input["type"] == "thread.create" {
            let result = self.create_thread(&input).await?;
            return Ok(json!({"sequence":result["sequence"]}));
        }
        let _guard = self.write_gate.lock().await;
        let command_id = string(&input, "commandId")?;
        if let Some(receipt) = self.store.receipt(command_id).await? {
            return Ok(receipt);
        }
        let id = string(&input, "threadId")?;
        let mut shell = self
            .store
            .read("shell", id)
            .await?
            .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
        let mut thread = self
            .store
            .read("thread", id)
            .await?
            .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
        let timestamp = now();
        let mut extra = Vec::new();
        let mut start = None;
        let mut stop = false;
        match string(&input, "type")? {
            "message.dispatch" => {
                if thread["interactionMode"] == "plan" {
                    return Err(Error::Unsupported("native planning mode".into()));
                }
                if !matches!(
                    thread["runtimeMode"].as_str(),
                    Some("full-access" | "approval-required" | "auto" | "auto-accept-edits")
                ) {
                    return Err(Error::Invalid("Unknown runtime mode".into()));
                }
                if !shell["activeRunId"].is_null() {
                    return Err(Error::Invalid(
                        "Stop the active turn before sending another task".into(),
                    ));
                }
                if input["attachments"]
                    .as_array()
                    .is_some_and(|attachments| !attachments.is_empty())
                {
                    return Err(Error::Unsupported("attachments".into()));
                }
                let text = input["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .ok_or_else(|| Error::Invalid("Message is empty".into()))?;
                let run_id = Uuid::new_v4().to_string();
                let message_id = string(&input, "messageId")?;
                let mut run = DEFAULTS["run"].clone();
                run["id"] = json!(run_id);
                run["threadId"] = json!(id);
                run["userMessageId"] = json!(message_id);
                run["modelSelection"] = input
                    .get("modelSelection")
                    .cloned()
                    .unwrap_or(shell["modelSelection"].clone());
                run["providerInstanceId"] = run["modelSelection"]["instanceId"].clone();
                run["ordinal"] = json!(self.store.list("run", Some(id)).await?.len() + 1);
                run["requestedAt"] = json!(timestamp);
                let mut item = DEFAULTS["userItem"].clone();
                item["id"] = json!(message_id);
                item["messageId"] = json!(message_id);
                item["threadId"] = json!(id);
                item["runId"] = json!(run_id);
                item["text"] = json!(text);
                item["ordinal"] = shell["itemCount"].clone();
                for key in ["startedAt", "completedAt", "updatedAt"] {
                    item[key] = json!(timestamp);
                }
                let mut item_document = Document::new("item", message_id, Some(id), item);
                item_document.ordinal = shell["itemCount"].as_i64().unwrap_or(0);
                extra.push(item_document);
                extra.push(Document::new("run", &run_id, Some(id), run.clone()));
                shell["activeRunId"] = json!(run_id);
                shell["latestRunId"] = json!(run_id);
                shell["status"] = json!("queued");
                shell["latestUserMessageAt"] = json!(timestamp);
                shell["itemCount"] = json!(shell["itemCount"].as_u64().unwrap_or(0) + 1);
                shell["visibleItemCount"] = shell["itemCount"].clone();
                start = Some(run);
            }
            "thread.stop" => {
                stop = true;
            }
            "thread.archive" => {
                if !shell["activeRunId"].is_null() {
                    return Err(Error::Invalid(
                        "Stop the active turn before archiving".into(),
                    ));
                }
                shell["archivedAt"] = json!(timestamp);
                thread["archivedAt"] = json!(timestamp);
            }
            "thread.unarchive" => {
                shell["archivedAt"] = Value::Null;
                thread["archivedAt"] = Value::Null;
            }
            "thread.visit" => {
                shell["lastVisitedAt"] = json!(timestamp);
                thread["lastVisitedAt"] = json!(timestamp);
            }
            "thread.metadata.update" => {
                if let Some(title) = input.get("title") {
                    shell["title"] = title.clone();
                    thread["title"] = title.clone();
                }
            }
            "thread.model-selection.set" => {
                string(&input["modelSelection"], "instanceId")?;
                string(&input["modelSelection"], "model")?;
                shell["modelSelection"] = input["modelSelection"].clone();
                thread["modelSelection"] = input["modelSelection"].clone();
                shell["providerInstanceId"] = input["modelSelection"]["instanceId"].clone();
                thread["providerInstanceId"] = shell["providerInstanceId"].clone();
            }
            "thread.runtime-mode.set" => {
                shell["runtimeMode"] = input["runtimeMode"].clone();
                thread["runtimeMode"] = input["runtimeMode"].clone();
            }
            "thread.interaction-mode.set" => {
                shell["interactionMode"] = input["interactionMode"].clone();
                thread["interactionMode"] = input["interactionMode"].clone();
            }
            other => return Err(Error::Unsupported(other.into())),
        }
        shell["updatedAt"] = json!(timestamp);
        thread["updatedAt"] = json!(timestamp);
        extra.push(Document::new("thread", id, None, thread));
        extra.push(Document::new("shell", id, None, shell.clone()));
        let result = self
            .store
            .commit(
                command_id,
                &extra,
                &json!({"type":input["type"],"threadId":id}),
            )
            .await?;
        if stop && let Some((_, cancel)) = self.running.lock().await.get(id) {
            cancel.cancel();
        }
        let sequence = result["sequence"].as_i64().unwrap_or(0);
        let _=self.changed.send(Change {sequence,shell:Some(json!({"kind":"thread.updated","sequence":sequence,"location":if shell["archivedAt"].is_null(){"active"}else{"archive"},"thread":shell})),thread_id:Some(id.into()),event:None,snapshot:true,config:false});
        if let Some(run) = start {
            super::provider::start(self.clone(), id.to_owned(), run).await;
        }
        Ok(result)
    }
}
