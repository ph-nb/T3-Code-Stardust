use super::{
    DEFAULTS,
    domain::{Change, Error, Service},
    now,
    store::Document,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) struct Codex {
    _group: super::process::ProcessGroup,
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    pending: VecDeque<Value>,
    next_id: u64,
    loaded_thread: Option<String>,
}
pub(super) type BorrowClient = tokio::sync::oneshot::Sender<tokio::sync::oneshot::Sender<Codex>>;

async fn take_client(service: &Service, thread_id: &str) -> Result<Codex, Error> {
    let request = service.idle_clients.lock().await.remove(thread_id);
    if let Some(request) = request {
        let (send, receive) = tokio::sync::oneshot::channel();
        if request.send(send).is_ok()
            && let Ok(client) = receive.await
        {
            return Ok(client);
        }
    }
    Codex::spawn().await
}

async fn park_client(service: Arc<Service>, thread_id: &str, mut client: Codex) {
    let (send, mut receive) = tokio::sync::oneshot::channel();
    service
        .idle_clients
        .lock()
        .await
        .insert(thread_id.to_owned(), send);
    tokio::spawn(async move {
        enum Event {
            Stop,
            Take(
                Result<tokio::sync::oneshot::Sender<Codex>, tokio::sync::oneshot::error::RecvError>,
            ),
            Frame(Result<Value, Error>),
        }
        loop {
            let event = tokio::select! {_=service.shutdown.cancelled()=>Event::Stop,request=&mut receive=>Event::Take(request),frame=client.read()=>Event::Frame(frame)};
            match event {
                Event::Take(Ok(send)) => {
                    let _ = send.send(client);
                    return;
                }
                Event::Frame(Ok(frame)) => {
                    if frame.get("id").is_some() && frame.get("method").is_some() {
                        let _=client.send(json!({"id":frame["id"],"error":{"code":-32601,"message":"No active native turn owns this request"}})).await;
                    }
                }
                _ => return,
            }
        }
    });
}

fn executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("STARDUST_CODEX_BIN")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/ChatGPT/app/resources/codex.exe"));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(roaming).join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            candidates.push(path.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub(super) async fn auth_state(service: &Service, instance: &str) -> Value {
    service.auth_states.read().await.get(instance).cloned().unwrap_or_else(||json!({
        "instanceId":instance,"phase":"idle","flowId":null,"authorizationUrl":null,"expiresAt":null,"message":null,
        "methods":[{"id":"chatgpt","name":"ChatGPT","description":null,"type":"agent"},{"id":"api-key","name":"API key","description":null,"type":"credentials"}],
        "interaction":null,"credentialOwner":"provider"
    }))
}

async fn set_auth_state(service: &Service, state: Value) {
    service
        .auth_states
        .write()
        .await
        .insert("codex".into(), state);
    let _ = service.changed.send(Change {
        sequence: 0,
        shell: None,
        thread_id: None,
        event: None,
        snapshot: false,
        config: true,
    });
}

pub(super) async fn login_cancel(service: Arc<Service>, input: Value) -> Result<Value, Error> {
    if input["instanceId"] != "codex" {
        return Err(Error::Unsupported("provider authentication".into()));
    }
    let mut state = auth_state(&service, "codex").await;
    if input.get("flowId").is_some() && input["flowId"] != state["flowId"] {
        return Err(Error::Invalid("Authentication flow has changed".into()));
    }
    let old = service.auth_tasks.lock().await.remove("codex");
    if let Some(task) = old {
        task.abort();
        let _ = task.await;
    }
    state["phase"] = json!("cancelled");
    state["interaction"] = Value::Null;
    state["authorizationUrl"] = Value::Null;
    set_auth_state(&service, state.clone()).await;
    Ok(state)
}

pub(super) async fn login_start(service: Arc<Service>, input: Value) -> Result<Value, Error> {
    if input["instanceId"] != "codex" {
        return Err(Error::Unsupported("provider authentication".into()));
    }
    let old = service.auth_tasks.lock().await.remove("codex");
    if let Some(task) = old {
        task.abort();
        let _ = task.await;
    }
    let mut state = auth_state(&service, "codex").await;
    if input["methodId"] == "api-key" {
        let id = super::token();
        state["phase"] = json!("waiting");
        state["flowId"] = json!(id);
        state["authorizationUrl"] = Value::Null;
        state["interaction"] = json!({"type":"credentials","id":id,"fields":[{"name":"apiKey","label":"API key","secret":true}]});
        set_auth_state(&service, state.clone()).await;
        return Ok(state);
    }
    let mut client = Codex::spawn().await?;
    let response = client
        .request("account/login/start", json!({"type":"chatgpt"}))
        .await?;
    let login_id = response["loginId"]
        .as_str()
        .ok_or_else(|| Error::Invalid("Codex did not start an authentication flow".into()))?
        .to_owned();
    let auth_url = response["authUrl"]
        .as_str()
        .ok_or_else(|| Error::Invalid("Codex did not provide a login URL".into()))?;
    let parsed = url::Url::parse(auth_url)
        .map_err(|_| Error::Invalid("Codex returned an invalid login URL".into()))?;
    if parsed.scheme() != "https" {
        return Err(Error::Invalid("Codex login requires HTTPS".into()));
    }
    state["phase"] = json!("waiting");
    state["flowId"] = json!(login_id);
    state["authorizationUrl"] = json!(auth_url);
    state["interaction"] =
        json!({"type":"browser","id":login_id,"url":auth_url,"requiresConsent":false});
    set_auth_state(&service, state.clone()).await;
    let owned_service = service.clone();
    let task = tokio::spawn(async move {
        let completed = async {
            loop {
                let frame = if let Some(frame) = client.pending.pop_front() {
                    frame
                } else {
                    client.read().await?
                };
                if frame["method"] == "account/login/completed"
                    && frame["params"]["loginId"] == login_id
                {
                    return Ok::<_, Error>(frame["params"]["success"].as_bool() == Some(true));
                }
            }
        };
        let result = tokio::select! {_=owned_service.shutdown.cancelled()=>Err(Error::Invalid("Local runtime stopped".into())),result=completed=>result};
        let mut state = auth_state(&owned_service, "codex").await;
        state["phase"] = json!(if matches!(result, Ok(true)) {
            "succeeded"
        } else {
            "failed"
        });
        state["interaction"] = Value::Null;
        state["authorizationUrl"] = Value::Null;
        if !matches!(result, Ok(true)) {
            state["message"] = json!("Codex authentication did not complete");
        }
        set_auth_state(&owned_service, state).await;
        let _ = client.child.kill().await;
        if matches!(result, Ok(true)) {
            discover(owned_service).await;
        }
    });
    service.auth_tasks.lock().await.insert("codex".into(), task);
    Ok(state)
}

pub(super) async fn login_respond(service: Arc<Service>, input: Value) -> Result<Value, Error> {
    if input["instanceId"] != "codex" {
        return Err(Error::Unsupported("provider authentication".into()));
    }
    let mut state = auth_state(&service, "codex").await;
    if input["flowId"] != state["flowId"] {
        return Err(Error::Invalid("Authentication flow has changed".into()));
    }
    if input["response"]["type"] == "browser" {
        if input["response"]["action"] == "decline" {
            return login_cancel(service, input).await;
        }
        return Ok(state);
    }
    if input["response"]["type"] != "credentials" {
        return Err(Error::Unsupported("authentication response".into()));
    }
    let key = input["response"]["values"]["apiKey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| Error::Invalid("API key is empty".into()))?;
    let mut client = Codex::spawn().await?;
    client
        .request("account/login/start", json!({"type":"apiKey","apiKey":key}))
        .await?;
    let _ = client.child.kill().await;
    state["phase"] = json!("succeeded");
    state["interaction"] = Value::Null;
    set_auth_state(&service, state.clone()).await;
    discover(service).await;
    Ok(state)
}

impl Codex {
    async fn spawn() -> Result<Self, Error> {
        let executable =
            executable().ok_or_else(|| Error::Missing("Codex CLI is not installed".into()))?;
        let mut command = Command::new(executable);
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let group = super::process::ProcessGroup::attach(&child)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| Error::Invalid("Codex stdin is unavailable".into()))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| Error::Invalid("Codex stdout is unavailable".into()))?,
        )
        .lines();
        let mut client = Self {
            _group: group,
            child,
            input,
            output,
            pending: VecDeque::new(),
            next_id: 0,
            loaded_thread: None,
        };
        client.request("initialize",json!({"clientInfo":{"name":"stardust_native","title":"Stardust","version":crate::RUNTIME_VERSION},"capabilities":{"experimentalApi":true}})).await?;
        client.send(json!({"method":"initialized"})).await?;
        Ok(client)
    }
    async fn send(&mut self, value: Value) -> Result<(), Error> {
        self.input.write_all(value.to_string().as_bytes()).await?;
        self.input.write_all(b"\n").await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn read(&mut self) -> Result<Value, Error> {
        loop {
            let line = self
                .output
                .next_line()
                .await?
                .ok_or_else(|| Error::Invalid("Codex app-server exited".into()))?;
            if line.len() > 8 * 1024 * 1024 {
                return Err(Error::Invalid(
                    "Codex frame exceeds the native limit".into(),
                ));
            }
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            let value = self.read().await?;
            if value["id"] == id && value.get("method").is_none() {
                if value.get("error").is_some() {
                    return Err(Error::Invalid(format!(
                        "Codex rejected {method} (code {})",
                        value["error"]["code"].as_i64().unwrap_or(0)
                    )));
                }
                return Ok(value["result"].clone());
            }
            self.pending.push_back(value);
        }
    }
}

pub(super) async fn discover(service: Arc<Service>) {
    let provider = if executable().is_none() {
        json!({"instanceId":"codex","driver":"codex","enabled":true,"installed":false,"version":null,"status":"error","auth":{"status":"unknown"},"checkedAt":now(),"models":[]})
    } else {
        match tokio::time::timeout(std::time::Duration::from_secs(15),async{
            let mut client=Codex::spawn().await?;
            let account=client.request("account/read",json!({})).await?;
            let models=client.request("model/list",json!({})).await?;
            let authenticated=!account["account"].is_null()||account["requiresOpenaiAuth"].as_bool()==Some(false);
            let catalog=models["data"].as_array().into_iter().flatten().map(|model|json!({"slug":model.get("model").or_else(||model.get("id")).cloned().unwrap_or(json!("default")),"name":model.get("displayName").or_else(||model.get("model")).cloned().unwrap_or(json!("Codex")),"isCustom":false,"capabilities":null})).collect::<Vec<_>>();
            let _=client.child.kill().await;
            Ok::<_,Error>(json!({"instanceId":"codex","driver":"codex","enabled":true,"installed":true,"version":"native","status":"ready","auth":{"status":if authenticated{"authenticated"}else{"unauthenticated"}},"checkedAt":now(),"models":catalog}))
        }).await {Ok(Ok(provider))=>provider,_=>json!({"instanceId":"codex","driver":"codex","enabled":true,"installed":true,"version":null,"status":"error","auth":{"status":"unknown"},"checkedAt":now(),"models":[]})}
    };
    let mut providers = vec![provider];
    if std::env::var("STARDUST_TEST_REPLAY").as_deref() == Ok("1") {
        providers.push(json!({"instanceId":"devReplay","driver":"devReplay","enabled":true,"installed":true,"version":"fixture","status":"ready","auth":{"status":"authenticated"},"checkedAt":now(),
            "models":[{"slug":"showcase","name":"Replay (dev)","isCustom":false,"capabilities":null},{"slug":"hold","name":"Replay cancellation (dev)","isCustom":false,"capabilities":null}]}));
    }
    service.config.write().await["providers"] = json!(providers);
    let _ = service.changed.send(Change {
        sequence: 0,
        shell: None,
        thread_id: None,
        event: None,
        snapshot: false,
        config: true,
    });
}

pub(super) async fn start(service: Arc<Service>, thread_id: String, run: Value) {
    let cancel = service.shutdown.child_token();
    let run_id = run["id"].as_str().unwrap_or("").to_owned();
    service
        .running
        .lock()
        .await
        .insert(thread_id.clone(), (run_id.clone(), cancel.clone()));
    tokio::spawn(async move {
        let result = tokio::select! {_=cancel.cancelled()=>Ok(()),result=execute(service.clone(),&thread_id,run.clone(),cancel.clone())=>result};
        let status = if cancel.is_cancelled() {
            "interrupted"
        } else if result.is_ok() {
            "completed"
        } else {
            "failed"
        };
        let _ = finish(
            service.clone(),
            &thread_id,
            run,
            status,
            result.err().map(|error| error.to_string()),
        )
        .await;
        let mut running = service.running.lock().await;
        if running.get(&thread_id).is_some_and(|(id, _)| id == &run_id) {
            running.remove(&thread_id);
        }
    });
}

async fn execute(
    service: Arc<Service>,
    thread_id: &str,
    mut run: Value,
    cancel: CancellationToken,
) -> Result<(), Error> {
    if run["providerInstanceId"] == "devReplay"
        && std::env::var("STARDUST_TEST_REPLAY").as_deref() == Ok("1")
    {
        run["status"] = json!("running");
        run["startedAt"] = json!(now());
        update_run(service.clone(), thread_id, &run, None).await?;
        if run["modelSelection"]["model"] == "hold" {
            cancel.cancelled().await;
            return Ok(());
        }
        if run["modelSelection"]["model"] == "approval" {
            let response = super::requests::ask(
                service.clone(),
                thread_id,
                &run,
                "command",
                "Replay fixture: approve this simulated command",
            )
            .await?;
            if response["decision"] != "accept" {
                return Err(Error::Invalid("Replay approval was declined".into()));
            }
        }
        let mut item = DEFAULTS["assistantItem"].clone();
        let id = Uuid::new_v4().to_string();
        item["id"] = json!(id);
        item["messageId"] = json!(id);
        item["threadId"] = json!(thread_id);
        item["runId"] = run["id"].clone();
        item["text"] = json!("Native Rust replay completed.");
        for key in ["startedAt", "completedAt", "updatedAt"] {
            item[key] = json!(now());
        }
        publish_item(service, thread_id, &mut item).await?;
        return Ok(());
    }
    if run["providerInstanceId"] != "codex" {
        return Err(Error::Unsupported("provider driver".into()));
    }
    let thread = service
        .store
        .read("thread", thread_id)
        .await?
        .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
    let project = service
        .store
        .read("project", thread["projectId"].as_str().unwrap_or(""))
        .await?
        .ok_or_else(|| Error::Missing("Unknown project".into()))?;
    let message = service
        .store
        .read("item", run["userMessageId"].as_str().unwrap_or(""))
        .await?
        .ok_or_else(|| Error::Missing("Unknown message".into()))?;
    let mut client = take_client(&service, thread_id).await?;
    let mode = thread["runtimeMode"]
        .as_str()
        .unwrap_or("approval-required");
    let cwd = thread["worktreePath"]
        .as_str()
        .map(Value::from)
        .unwrap_or(project["workspaceRoot"].clone());
    let mut params = json!({"cwd":cwd,"approvalPolicy":if mode=="full-access"{"never"}else if mode=="approval-required"{"untrusted"}else{"on-request"},"sandbox":if mode=="full-access"{"danger-full-access"}else{"workspace-write"}});
    if let Some(model) = run["modelSelection"]["model"]
        .as_str()
        .filter(|model| *model != "default")
    {
        params["model"] = json!(model);
    }
    let native = service.store.read("native-thread", thread_id).await?;
    let native_thread = if let Some(native) = native {
        params["threadId"] = native["nativeId"].clone();
        if client.loaded_thread.as_deref() == native["nativeId"].as_str() {
            json!({"thread":{"id":native["nativeId"]}})
        } else {
            client.request("thread/resume", params).await?
        }
    } else {
        client.request("thread/start", params).await?
    };
    let native_id = native_thread["thread"]["id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("Codex did not return a thread identifier".into()))?
        .to_owned();
    client.loaded_thread = Some(native_id.clone());
    service
        .store
        .commit(
            &super::token(),
            &[Document::new(
                "native-thread",
                thread_id,
                None,
                json!({"nativeId":native_id}),
            )],
            &json!({"type":"provider.attached","threadId":thread_id}),
        )
        .await?;
    let mut turn_input = json!({"threadId":native_id,"input":[{"type":"text","text":message["text"],"text_elements":[]}],
        "cwd":cwd,"approvalPolicy":if mode=="full-access"{"never"}else if mode=="approval-required"{"untrusted"}else{"on-request"},
        "sandboxPolicy":if mode=="full-access"{json!({"type":"dangerFullAccess"})}else{json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})}});
    if let Some(model) = run["modelSelection"]["model"]
        .as_str()
        .filter(|model| *model != "default")
    {
        turn_input["model"] = json!(model);
    }
    if let Some(options) = run["modelSelection"]["options"].as_array() {
        for option in options {
            if matches!(
                option["id"].as_str(),
                Some("reasoningEffort" | "reasoning_effort" | "effort")
            ) && option["value"].is_string()
            {
                turn_input["effort"] = option["value"].clone();
            }
        }
    }
    let turn = client.request("turn/start", turn_input).await?;
    let native_turn = turn["turn"]["id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("Codex did not return a turn identifier".into()))?
        .to_owned();
    run["status"] = json!("running");
    run["startedAt"] = json!(now());
    update_run(service.clone(), thread_id, &run, None).await?;
    let mut assistants: HashMap<String, Value> = HashMap::new();
    loop {
        let frame = if let Some(frame) = client.pending.pop_front() {
            frame
        } else {
            tokio::select! {
                _=cancel.cancelled()=>{let _=client.request("turn/interrupt",json!({"threadId":native_id,"turnId":native_turn})).await;let _=client.child.kill().await;return Ok(());},
                frame=client.read()=>frame?,
            }
        };
        if frame.get("id").is_some() && frame.get("method").is_some() {
            let method = frame["method"].as_str().unwrap_or("");
            if matches!(
                method,
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
            ) {
                let command = frame["params"]["command"].as_str().unwrap_or("");
                let reason = frame["params"]["reason"].as_str().unwrap_or("");
                let result = super::requests::ask(
                    service.clone(),
                    thread_id,
                    &run,
                    if method.contains("fileChange") {
                        "file-change"
                    } else {
                        "command"
                    },
                    &format!("{command}\n{reason}"),
                )
                .await?;
                client
                    .send(json!({"id":frame["id"],"result":result}))
                    .await?;
            } else {
                client.send(json!({"id":frame["id"],"error":{"code":-32601,"message":"This native provider request is not supported"}})).await?;
            }
            continue;
        }
        match frame["method"].as_str().unwrap_or("") {
            "item/agentMessage/delta" => {
                if let Some(delta) = frame["params"]["delta"].as_str() {
                    let key = frame["params"]["itemId"].as_str().unwrap_or("assistant");
                    let assistant = assistants
                        .entry(key.to_owned())
                        .or_insert_with(|| assistant_item(thread_id, &run, key));
                    let mut text = assistant["text"].as_str().unwrap_or("").to_owned();
                    text.push_str(delta);
                    assistant["text"] = json!(text);
                    publish_item(service.clone(), thread_id, assistant).await?;
                }
            }
            "item/completed" if frame["params"]["item"]["type"] == "agentMessage" => {
                let native = &frame["params"]["item"];
                let key = native["id"].as_str().unwrap_or("assistant");
                let assistant = assistants
                    .entry(key.to_owned())
                    .or_insert_with(|| assistant_item(thread_id, &run, key));
                if let Some(text) = native["text"].as_str() {
                    assistant["text"] = json!(text);
                }
                if matches!(
                    native["phase"].as_str(),
                    Some("commentary" | "partial_answer" | "final_answer")
                ) {
                    assistant["phase"] = native["phase"].clone();
                }
                assistant["status"] = json!("completed");
                assistant["streaming"] = json!(false);
                assistant["completedAt"] = json!(now());
                if assistant["text"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
                {
                    publish_item(service.clone(), thread_id, assistant).await?;
                }
            }
            "turn/completed" => {
                let status = frame["params"]["turn"]["status"]
                    .as_str()
                    .unwrap_or("completed");
                for assistant in assistants.values_mut() {
                    assistant["status"] = json!("completed");
                    assistant["streaming"] = json!(false);
                    assistant["completedAt"] = json!(now());
                    if assistant["text"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty())
                    {
                        publish_item(service.clone(), thread_id, assistant).await?;
                    }
                }
                if status == "failed" {
                    return Err(Error::Invalid("Codex could not complete the turn; check provider authentication and model availability".into()));
                }
                if status == "interrupted" || status == "cancelled" {
                    cancel.cancel();
                    return Ok(());
                }
                if status != "completed" {
                    return Err(Error::Invalid(
                        "Codex returned an unexpected terminal state".into(),
                    ));
                }
                park_client(service.clone(), thread_id, client).await;
                return Ok(());
            }
            _ => {}
        }
    }
}

fn assistant_item(thread_id: &str, run: &Value, native_id: &str) -> Value {
    let mut item = DEFAULTS["assistantItem"].clone();
    let id = Uuid::new_v4().to_string();
    item["id"] = json!(id);
    item["messageId"] = json!(id);
    item["threadId"] = json!(thread_id);
    item["runId"] = run["id"].clone();
    item["nativeItemRef"] = json!({"driver":"codex","nativeId":native_id,"strength":"strong"});
    item["status"] = json!("running");
    item["streaming"] = json!(true);
    item["completedAt"] = Value::Null;
    item["startedAt"] = json!(now());
    item
}

pub(super) async fn publish_item(
    service: Arc<Service>,
    thread_id: &str,
    item: &mut Value,
) -> Result<(), Error> {
    let _guard = service.write_gate.lock().await;
    let id = item["id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("Missing item id".into()))?
        .to_owned();
    let mut shell = service
        .store
        .read("shell", thread_id)
        .await?
        .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
    if service.store.read("item", &id).await?.is_none() {
        item["ordinal"] = shell["itemCount"].clone();
        shell["itemCount"] = json!(shell["itemCount"].as_u64().unwrap_or(0) + 1);
        shell["visibleItemCount"] = shell["itemCount"].clone();
    }
    item["updatedAt"] = json!(now());
    let event = json!({"id":Uuid::new_v4().to_string(),"threadId":thread_id,"occurredAt":now(),"type":"turn-item.updated","payload":item});
    let mut document = Document::new("item", &id, Some(thread_id), item.clone());
    document.ordinal = item["ordinal"].as_i64().unwrap_or(0);
    let result = service
        .store
        .commit(
            &super::token(),
            &[document, Document::new("shell", thread_id, None, shell)],
            &event,
        )
        .await?;
    let _ = service.changed.send(Change {
        sequence: result["sequence"].as_i64().unwrap_or(0),
        shell: None,
        thread_id: Some(thread_id.into()),
        event: Some(event),
        snapshot: false,
        config: false,
    });
    Ok(())
}

async fn update_run(
    service: Arc<Service>,
    thread_id: &str,
    run: &Value,
    error: Option<String>,
) -> Result<(), Error> {
    let _guard = service.write_gate.lock().await;
    let mut shell = service
        .store
        .read("shell", thread_id)
        .await?
        .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
    shell["status"] = run["status"].clone();
    shell["updatedAt"] = json!(now());
    if !run["completedAt"].is_null() {
        shell["activeRunId"] = Value::Null;
        shell["pendingRuntimeRequest"] = Value::Null;
    }
    if let Some(error) = error {
        shell["lastError"] = json!(error);
    }
    let event = json!({"id":Uuid::new_v4().to_string(),"threadId":thread_id,"occurredAt":now(),"type":"run.updated","payload":run});
    let result = service
        .store
        .commit(
            &super::token(),
            &[
                Document::new(
                    "run",
                    run["id"].as_str().unwrap_or(""),
                    Some(thread_id),
                    run.clone(),
                ),
                Document::new("shell", thread_id, None, shell.clone()),
            ],
            &event,
        )
        .await?;
    let sequence = result["sequence"].as_i64().unwrap_or(0);
    let _ = service.changed.send(Change {
        sequence,
        shell: Some(
            json!({"kind":"thread.updated","sequence":sequence,"location":"active","thread":shell}),
        ),
        thread_id: Some(thread_id.into()),
        event: Some(event),
        snapshot: false,
        config: false,
    });
    Ok(())
}
async fn finish(
    service: Arc<Service>,
    thread_id: &str,
    mut run: Value,
    status: &str,
    error: Option<String>,
) -> Result<(), Error> {
    if status != "completed" {
        service.idle_clients.lock().await.remove(thread_id);
    }
    super::requests::close(&service, run["id"].as_str().unwrap_or("")).await?;
    if let Some(current) = service
        .store
        .read("run", run["id"].as_str().unwrap_or(""))
        .await?
    {
        run = current;
    }
    run["status"] = json!(status);
    run["completedAt"] = json!(now());
    update_run(service, thread_id, &run, error).await
}

pub(super) async fn recover(service: Arc<Service>) -> Result<(), Error> {
    for run in service.store.list("run", None).await? {
        if matches!(
            run["status"].as_str(),
            Some("queued" | "preparing" | "starting" | "running" | "waiting")
        ) {
            let id = run["threadId"].as_str().unwrap_or("").to_owned();
            finish(
                service.clone(),
                &id,
                run,
                "interrupted",
                Some("The local runtime restarted during this task".into()),
            )
            .await?;
        }
    }
    Ok(())
}
