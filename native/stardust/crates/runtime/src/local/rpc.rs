use super::{
    domain::{Error, Service, string},
    store::Document,
};
use serde_json::{Value, json};
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};

fn expand(path: &str, cwd: &str) -> PathBuf {
    let root = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(cwd));
    if path == "~" {
        return root;
    }
    if let Some(relative) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return root.join(relative);
    }
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        PathBuf::from(cwd).join(path)
    }
}

pub(super) async fn call(service: Arc<Service>, tag: &str, input: Value) -> Result<Value, Error> {
    match tag {
        "server.reportClientActivity" => {
            service
                .client_reports
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Value::Null)
        }
        "provider.auth.start" => super::provider::login_start(service, input).await,
        "provider.auth.respond" => super::provider::login_respond(service, input).await,
        "provider.auth.cancel" => super::provider::login_cancel(service, input).await,
        "server.probe" => Ok(json!({})),
        "server.getConfig" => Ok(service.config.read().await.clone()),
        "server.getSettings" => Ok(service.config.read().await["settings"].clone()),
        "server.updateSettings" => {
            let _guard = service.write_gate.lock().await;
            let mut config = service.config.write().await;
            let patch = input.get("patch").unwrap_or(&input);
            if let Some(patch) = patch.as_object() {
                for (key, value) in patch {
                    config["settings"][key] = value.clone();
                }
            }
            let settings = config["settings"].clone();
            drop(config);
            service
                .store
                .commit(
                    &super::token(),
                    &[Document::new("settings", "server", None, settings.clone())],
                    &json!({"type":"settings.updated"}),
                )
                .await?;
            let _ = service.changed.send(super::domain::Change {
                sequence: 0,
                shell: None,
                thread_id: None,
                event: None,
                snapshot: false,
                config: true,
            });
            Ok(settings)
        }
        "server.refreshProviders" => {
            super::provider::discover(service.clone()).await;
            Ok(json!({"providers":service.config.read().await["providers"]}))
        }
        "projects.mutate" => service.project(input).await,
        "projects.ensureScratch" => {
            let root = PathBuf::from(
                service.config.read().await["scratchWorkspaceRoot"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
            if service
                .store
                .read("project", "native-scratch")
                .await?
                .is_none()
            {
                service.project(json!({"type":"project.create","commandId":"native-scratch-create","projectId":"native-scratch","title":"Scratch","workspaceRoot":root,"createWorkspaceRootIfMissing":true})).await?;
            }
            Ok(json!({"projectId":"native-scratch"}))
        }
        "projects.createNew" => {
            let name = string(&input, "name")?;
            if name == "." || name == ".." || name.contains(['/', '\\', ':']) {
                return Err(Error::Invalid(
                    "Choose a project name without path separators".into(),
                ));
            }
            let root = PathBuf::from(
                service.config.read().await["newProjectsRoot"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            )
            .join(name);
            if root.exists() {
                return Err(Error::Invalid(
                    "The project directory already exists".into(),
                ));
            }
            let id = super::token();
            let project=service.project(json!({"type":"project.create","commandId":super::token(),"projectId":id,"title":name,"workspaceRoot":root,"createWorkspaceRootIfMissing":true})).await?;
            Ok(json!({"projectId":id,"workspaceRoot":project["workspaceRoot"]}))
        }
        "orchestration.dispatchCommand" => service.dispatch(input).await,
        "orchestration.launchThread" => service.create_thread(&input).await,
        "orchestration.getThreadProjection" => {
            service.projection(string(&input, "threadId")?).await
        }
        "orchestration.getArchivedShellSnapshot" => {
            let shell = service.shell().await?;
            Ok(
                json!({"schemaVersion":1,"snapshotSequence":shell["snapshotSequence"],"projects":shell["projects"],"threads":shell["archivedThreads"]}),
            )
        }
        "orchestration.getThreadFamily" => {
            let id = string(&input, "threadId")?;
            let thread = service.store.read("shell", id).await?;
            Ok(
                json!({"snapshotSequence":service.store.sequence().await?,"threads":thread.into_iter().collect::<Vec<_>>()}),
            )
        }
        "orchestration.getThreadTitles" => {
            let mut titles = serde_json::Map::new();
            if let Some(ids) = input["threadIds"].as_array() {
                for id in ids {
                    if let Some(id) = id.as_str()
                        && let Some(thread) = service.store.read("thread", id).await?
                    {
                        titles.insert(id.into(), thread["title"].clone());
                    }
                }
            }
            Ok(Value::Object(titles))
        }
        "orchestration.getWorktreeThreadIds" => Ok(json!([])),
        "filesystem.browse" => {
            let cwd = input["cwd"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| service.directory.display().to_string());
            let partial = expand(string(&input, "partialPath")?, &cwd);
            let (parent, prefix) = if partial.is_dir() {
                (partial.clone(), String::new())
            } else {
                (
                    partial.parent().unwrap_or(Path::new(&cwd)).to_path_buf(),
                    partial
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase(),
                )
            };
            let mut directory = tokio::fs::read_dir(&parent).await?;
            let mut entries = Vec::new();
            while let Some(entry) = directory.next_entry().await? {
                if entry.file_type().await?.is_dir()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .starts_with(&prefix)
                {
                    entries.push(
                        json!({"name":entry.file_name().to_string_lossy(),"fullPath":entry.path()}),
                    );
                }
            }
            entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            Ok(json!({"parentPath":parent,"entries":entries}))
        }
        "filesystem.getMetadata" => {
            let mut entries = Vec::new();
            for path in input["paths"]
                .as_array()
                .ok_or_else(|| Error::Invalid("Expected paths".into()))?
            {
                let path = expand(
                    path.as_str().unwrap_or(""),
                    &service.directory.display().to_string(),
                );
                entries.push(match tokio::fs::metadata(path).await{Ok(metadata)=>json!({"kind":if metadata.is_dir(){"directory"}else if metadata.is_file(){"file"}else{"other"},"byteLength":metadata.len()}),Err(_)=>Value::Null});
            }
            Ok(json!({"entries":entries}))
        }
        "workspace.listFolders" => {
            let project = service
                .store
                .read("project", string(&input, "projectId")?)
                .await?
                .ok_or_else(|| Error::Missing("Unknown project".into()))?;
            let root = PathBuf::from(string(&project, "workspaceRoot")?);
            Ok(
                json!({"folders":[{"name":root.file_name().unwrap_or_default().to_string_lossy(),"path":root,"state":if root.join(".git").exists(){"git"}else{"plain"}}]}),
            )
        }
        "workspace.scanFolders" => {
            let root = expand(string(&input, "workspaceRoot")?, ".");
            Ok(
                json!({"workspaceRoot":root,"isGitRepository":root.join(".git").exists(),"codeWorkspaceFile":null,"folders":[]}),
            )
        }
        "projects.listEntries" | "projects.readFile" => {
            let root = expand(string(&input, "cwd")?, ".").canonicalize()?;
            let relative = Path::new(if tag == "projects.readFile" {
                string(&input, "relativePath")?
            } else {
                input["directoryPath"].as_str().unwrap_or("")
            });
            if relative
                .components()
                .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(Error::Invalid("Expected a path inside the project".into()));
            }
            let selected = if relative.is_absolute() {
                relative.to_path_buf()
            } else {
                root.join(relative)
            };
            if !selected.exists() && input["allowMissing"].as_bool() == Some(true) {
                return Ok(
                    json!({"relativePath":relative,"contents":"","byteLength":0,"truncated":false,"exists":false}),
                );
            }
            let selected = selected.canonicalize()?;
            if tag == "projects.listEntries" && !selected.starts_with(&root) {
                return Err(Error::Invalid("Path is outside the project".into()));
            }
            if tag == "projects.readFile" {
                use tokio::io::AsyncReadExt;
                let file = tokio::fs::File::open(&selected).await?;
                let length = file.metadata().await?.len();
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
                if bytes.iter().take(8192).any(|byte| *byte == 0) {
                    return Err(Error::Invalid(
                        "Binary file cannot be opened as text".into(),
                    ));
                }
                let text = String::from_utf8_lossy(&bytes[..bytes.len().min(1024 * 1024)]);
                Ok(
                    json!({"relativePath":relative,"contents":text,"byteLength":length,"truncated":bytes.len()>1024*1024,"exists":true}),
                )
            } else {
                let mut directory = tokio::fs::read_dir(selected).await?;
                let mut entries = Vec::new();
                while let Some(entry) = directory.next_entry().await? {
                    let path = entry.path();
                    entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":path.strip_prefix(&root).unwrap_or(path.as_path()),"kind":if entry.file_type().await?.is_dir(){"directory"}else{"file"}}));
                    if entries.len() >= 10000 {
                        break;
                    }
                }
                Ok(json!({"truncated":entries.len()>=10000,"entries":entries}))
            }
        }
        _ => Err(Error::Unsupported(tag.to_owned())),
    }
}
