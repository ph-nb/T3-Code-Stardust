use super::{
    DEFAULTS,
    auth::Auth,
    domain::{Error, Service},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

pub struct LocalAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub csp: Option<String>,
}
pub type AssetLoader = Arc<dyn Fn(&str) -> Option<LocalAsset> + Send + Sync>;

struct StateData {
    service: Arc<Service>,
    auth: Auth,
    assets: AssetLoader,
}

pub struct LocalServer {
    listener: tokio::net::TcpListener,
    router: Router,
    pub address: SocketAddr,
    pub shutdown: CancellationToken,
    bootstrap: crate::config::Secret,
    native_bootstrap: Value,
}

impl LocalServer {
    pub async fn bind(
        directory: PathBuf,
        assets: AssetLoader,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let service = Service::new(directory).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let auth = Auth::new(format!("http://{address}"), &service.store.environment_id);
        let bootstrap = crate::config::Secret::new(auth.bootstrap().to_owned());
        let native_bootstrap = json!({"environmentId":service.store.environment_id,"httpBaseUrl":format!("http://{address}/"),"bearerToken":auth.native()});
        service.config.write().await["auth"]["sessionCookieName"] = json!(auth.cookie_name);
        service.config.write().await["auth"]["sessionMethods"] =
            json!(["browser-session-cookie", "bearer-access-token"]);
        let shutdown = service.shutdown.clone();
        let state = Arc::new(StateData {
            service: service.clone(),
            auth,
            assets,
        });
        let router = Router::new()
            .route("/healthz", get(health))
            .route("/.well-known/t3/environment", get(descriptor))
            .route("/api/auth/session", get(session))
            .route("/api/auth/browser-session", post(exchange))
            .route("/api/auth/websocket-ticket", post(ticket))
            .route("/api/auth/websocket-ticket/{usage}", post(ticket))
            .route("/api/projects", get(projects))
            .route("/api/projects/mutate", post(mutate_project))
            .route("/api/orchestration/shell", get(shell))
            .route("/api/orchestration/threads/{id}", get(thread))
            .route("/ws", get(websocket))
            .fallback(get(asset))
            .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
            .layer(
                tower_http::cors::CorsLayer::new()
                    .allow_origin([
                        axum::http::HeaderValue::from_static("http://tauri.localhost"),
                        axum::http::HeaderValue::from_static("tauri://localhost"),
                    ])
                    .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                    .allow_headers(tower_http::cors::Any),
            )
            .with_state(state);
        tokio::spawn(async move {
            super::provider::discover(service).await;
        });
        Ok(Self {
            listener,
            router,
            address,
            shutdown,
            bootstrap,
            native_bootstrap,
        })
    }

    pub fn launch_url(&self) -> String {
        format!("http://{}/#token={}", self.address, self.bootstrap.expose())
    }
    pub fn desktop_bootstrap(&self) -> &Value {
        &self.native_bootstrap
    }

    pub async fn run(self) -> std::io::Result<()> {
        let shutdown = self.shutdown;
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(async move {
                shutdown.cancelled().await;
            })
            .await
    }
}

fn denied() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"_tag":"EnvironmentAuthRequiredError","message":"Authentication required"})),
    )
        .into_response()
}
fn failed(error: Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"_tag":"EnvironmentRequestInvalidError","message":error.to_string()})),
    )
        .into_response()
}

async fn health(State(state): State<Arc<StateData>>) -> Json<Value> {
    use std::sync::atomic::Ordering;
    Json(
        json!({"runtime":"rust","version":crate::RUNTIME_VERSION,"local":true,"database":"sqlite","environmentId":state.service.store.environment_id,
        "activeClients":state.service.clients.load(Ordering::Relaxed),"configAcknowledgements":state.service.config_acks.load(Ordering::Relaxed),"shellAcknowledgements":state.service.shell_acks.load(Ordering::Relaxed),"clientActivityReports":state.service.client_reports.load(Ordering::Relaxed)}),
    )
}
async fn descriptor(State(state): State<Arc<StateData>>) -> Json<Value> {
    Json(state.service.config.read().await["environment"].clone())
}
async fn session(State(state): State<Arc<StateData>>, headers: HeaderMap) -> Json<Value> {
    let mut value = json!({"authenticated":state.auth.authorized(&headers),"auth":state.service.config.read().await["auth"]});
    if value["authenticated"] == true {
        value["scopes"] = DEFAULTS["scopes"].clone();
        value["permissions"] = DEFAULTS["permissions"].clone();
        value["sessionMethod"] = json!(if headers.contains_key("authorization") {
            "bearer-access-token"
        } else {
            "browser-session-cookie"
        });
        if !headers.contains_key("authorization") {
            value["expiresAt"] = json!(state.auth.cookie_expires_at);
        }
    }
    Json(value)
}
#[derive(Deserialize)]
struct Credential {
    credential: String,
}
async fn exchange(
    State(state): State<Arc<StateData>>,
    headers: HeaderMap,
    Json(input): Json<Credential>,
) -> Response {
    if !state.auth.origin_allowed(&headers) {
        return denied();
    }
    let Some(cookie) = state.auth.exchange(&input.credential) else {
        return denied();
    };
    let body = json!({"authenticated":true,"scopes":DEFAULTS["scopes"],"permissions":DEFAULTS["permissions"],"sessionMethod":"browser-session-cookie","expiresAt":state.auth.cookie_expires_at});
    ([(header::SET_COOKIE, cookie)], Json(body)).into_response()
}
fn expiry(seconds: i64) -> String {
    (time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
        .format(&time::format_description::well_known::Rfc3339)
        .expect("expiry")
}
async fn ticket(State(state): State<Arc<StateData>>, headers: HeaderMap) -> Response {
    if !state.auth.authorized(&headers) {
        return denied();
    }
    Json(json!({"ticket":state.auth.issue_ticket(Instant::now()),"expiresAt":expiry(30)}))
        .into_response()
}
async fn projects(State(state): State<Arc<StateData>>, headers: HeaderMap) -> Response {
    if !state.auth.authorized(&headers) {
        return denied();
    }
    match state.service.store.list("project", None).await {
        Ok(projects) => Json(json!({"projects":projects,"updatedAt":super::now()})).into_response(),
        Err(error) => failed(error.into()),
    }
}
async fn mutate_project(
    State(state): State<Arc<StateData>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if !state.auth.authorized(&headers) {
        return denied();
    }
    match state.service.project(input).await {
        Ok(project) => Json(project).into_response(),
        Err(error) => failed(error),
    }
}
async fn shell(State(state): State<Arc<StateData>>, headers: HeaderMap) -> Response {
    if !state.auth.authorized(&headers) {
        return denied();
    }
    match state.service.shell().await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => failed(error),
    }
}
async fn thread(
    State(state): State<Arc<StateData>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !state.auth.authorized(&headers) {
        return denied();
    }
    match state.service.thread_snapshot(&id).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => failed(error),
    }
}
async fn asset(State(state): State<Arc<StateData>>, uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("oauth/") || path.starts_with(".well-known/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };
    let selected = (state.assets)(path).or_else(|| {
        if !path.rsplit('/').next().unwrap_or("").contains('.') {
            (state.assets)("index.html")
        } else {
            None
        }
    });
    let Some(asset) = selected else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(value) = asset.mime_type.parse() {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    if let Some(csp) = asset.csp.and_then(|value| value.parse().ok()) {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketQuery {
    #[serde(default)]
    ws_ticket: String,
}
async fn websocket(
    State(state): State<Arc<StateData>>,
    headers: HeaderMap,
    Query(query): Query<SocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !state.auth.origin_allowed(&headers)
        || !state.auth.take_ticket(&query.ws_ticket, Instant::now())
    {
        return denied();
    }
    upgrade
        .max_message_size(1024 * 1024)
        .on_upgrade(move |socket| connection(socket, state.service.clone()))
        .into_response()
}

struct Subscription {
    cancel: CancellationToken,
    ack: Arc<Notify>,
    tag: String,
}

async fn send_chunk(
    tx: &mpsc::Sender<Value>,
    id: &Value,
    values: Vec<Value>,
    ack: &Notify,
    cancel: &CancellationToken,
) -> bool {
    if tx
        .send(json!({"_tag":"Chunk","requestId":id,"values":values}))
        .await
        .is_err()
    {
        return false;
    }
    tokio::select! {_=cancel.cancelled()=>false,_=ack.notified()=>true}
}

async fn subscribe(
    service: Arc<Service>,
    id: Value,
    tag: String,
    input: Value,
    tx: mpsc::Sender<Value>,
    ack: Arc<Notify>,
    cancel: CancellationToken,
) {
    let mut updates = service.changed.subscribe();
    let thread_id = input["threadId"].as_str().unwrap_or("").to_owned();
    let snapshot = match tag.as_str() {
        "orchestration.subscribeShell" => service
            .shell()
            .await
            .map(|snapshot| json!({"kind":"snapshot","snapshot":snapshot})),
        "orchestration.subscribeThread" => {
            service
                .thread_snapshot(&thread_id)
                .await
                .map(|mut snapshot| {
                    snapshot["kind"] = json!("snapshot");
                    snapshot
                })
        }
        "subscribeServerConfig" => {
            Ok(json!({"version":1,"type":"snapshot","config":*service.config.read().await}))
        }
        "subscribeTerminalMetadata" => Ok(json!({"type":"snapshot","terminals":[]})),
        "subscribeVcsStatus" => Ok(Value::Null),
        "subscribeServerLifecycle" => Ok(
            json!({"version":1,"sequence":0,"type":"welcome","payload":{"environment":service.config.read().await["environment"],"cwd":service.config.read().await["cwd"],"projectName":"Stardust","bootstrapStatus":"complete"}}),
        ),
        "provider.auth.subscribe" => Ok(super::provider::auth_state(
            &service,
            input["instanceId"].as_str().unwrap_or("codex"),
        )
        .await),
        _ => Err(Error::Unsupported(tag.clone())),
    };
    let Ok(snapshot) = snapshot else {
        let _ = tx
            .send(rpc_failure(
                &id,
                &tag,
                &input,
                "Subscription is not available",
            ))
            .await;
        return;
    };
    let mut values = if snapshot.is_null() {
        vec![]
    } else {
        vec![snapshot]
    };
    if tag.starts_with("orchestration.") {
        values.push(json!({"kind":"synchronized"}));
    }
    if !values.is_empty() && !send_chunk(&tx, &id, values, &ack, &cancel).await {
        return;
    }
    loop {
        let change = tokio::select! {_=cancel.cancelled()=>break,_=service.shutdown.cancelled()=>break,change=updates.recv()=>change};
        let value = match change {
            Ok(change) => match tag.as_str() {
                "subscribeServerConfig" if change.config => Some(
                    json!({"version":1,"type":"snapshot","config":*service.config.read().await}),
                ),
                "provider.auth.subscribe" if change.config => Some(
                    super::provider::auth_state(
                        &service,
                        input["instanceId"].as_str().unwrap_or("codex"),
                    )
                    .await,
                ),
                "orchestration.subscribeShell" => change.shell,
                "orchestration.subscribeThread"
                    if change.thread_id.as_deref() == Some(&thread_id) =>
                {
                    if change.snapshot {
                        service
                            .thread_snapshot(&thread_id)
                            .await
                            .ok()
                            .map(|mut snapshot| {
                                snapshot["kind"] = json!("snapshot");
                                snapshot
                            })
                    } else {
                        change.event.map(|event|json!({"kind":"event","sequence":change.sequence,"event":event}))
                    }
                }
                _ => None,
            },
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if tag == "orchestration.subscribeShell" {
                    service
                        .shell()
                        .await
                        .ok()
                        .map(|snapshot| json!({"kind":"snapshot","snapshot":snapshot}))
                } else if tag == "orchestration.subscribeThread" {
                    service
                        .thread_snapshot(&thread_id)
                        .await
                        .ok()
                        .map(|mut snapshot| {
                            snapshot["kind"] = json!("snapshot");
                            snapshot
                        })
                } else {
                    None
                }
            }
            Err(_) => break,
        };
        if let Some(value) = value
            && !send_chunk(&tx, &id, vec![value], &ack, &cancel).await
        {
            break;
        }
    }
}

fn rpc_failure(id: &Value, tag: &str, input: &Value, message: &str) -> Value {
    let error = if tag == "orchestration.dispatchCommand" {
        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":input["commandId"],"commandType":input["type"],"message":message})
    } else {
        json!({"name":"NativeOperationError","message":message})
    };
    let cause = if tag == "orchestration.dispatchCommand" {
        json!({"_tag":"Fail","error":error})
    } else {
        json!({"_tag":"Die","defect":error})
    };
    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":[cause]}})
}

fn diagnostic(tag: &str, result: &str) {
    if std::env::var_os("STARDUST_NATIVE_DIAGNOSTICS").is_none() {
        return;
    }
    let known = DEFAULTS["methods"]
        .as_object()
        .is_some_and(|methods| methods.values().any(|value| value == tag));
    eprintln!(
        "native-rpc method={} result={result}",
        if known { tag } else { "unknown" }
    );
}

async fn connection(socket: WebSocket, service: Arc<Service>) {
    service
        .clients
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (mut output, mut input) = socket.split();
    let (tx, mut outgoing) = mpsc::channel::<Value>(32);
    let cancel = CancellationToken::new();
    let writer_cancel = cancel.clone();
    let writer = tokio::spawn(async move {
        while let Some(value) = outgoing.recv().await {
            if output
                .send(Message::Text(value.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        writer_cancel.cancel();
    });
    let mut subscriptions: HashMap<String, Subscription> = HashMap::new();
    loop {
        let message = tokio::select! {_=service.shutdown.cancelled()=>break,_=cancel.cancelled()=>break,message=input.next()=>message};
        let Some(Ok(message)) = message else {
            break;
        };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let frames = if let Some(frames) = value.as_array() {
            frames.clone()
        } else {
            vec![value]
        };
        for frame in frames {
            match frame["_tag"].as_str().unwrap_or("") {
                "Ping" => {
                    let _ = tx.send(json!({"_tag":"Pong"})).await;
                }
                "Ack" => {
                    if let Some(sub) = subscriptions.get(&frame["requestId"].to_string()) {
                        if sub.tag == "subscribeServerConfig" {
                            service
                                .config_acks
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        if sub.tag == "orchestration.subscribeShell" {
                            service
                                .shell_acks
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        sub.ack.notify_one();
                    }
                }
                "Interrupt" => {
                    if let Some(sub) = subscriptions.remove(&frame["requestId"].to_string()) {
                        sub.cancel.cancel();
                    }
                }
                "Eof" => {
                    cancel.cancel();
                }
                "Request" => {
                    let id = frame["id"].clone();
                    let tag = frame["tag"].as_str().unwrap_or("").to_owned();
                    let payload = frame["payload"].clone();
                    diagnostic(&tag, "received");
                    if tag.contains(".subscribe") || tag.starts_with("subscribe") {
                        let sub = Subscription {
                            cancel: cancel.child_token(),
                            ack: Arc::new(Notify::new()),
                            tag: tag.clone(),
                        };
                        tokio::spawn(subscribe(
                            service.clone(),
                            id.clone(),
                            tag,
                            payload,
                            tx.clone(),
                            sub.ack.clone(),
                            sub.cancel.clone(),
                        ));
                        if let Some(old) = subscriptions.insert(id.to_string(), sub) {
                            old.cancel.cancel();
                        }
                    } else {
                        let request_service = service.clone();
                        let request_tx = tx.clone();
                        tokio::spawn(async move {
                            let result =
                                super::rpc::call(request_service, &tag, payload.clone()).await;
                            diagnostic(&tag, if result.is_ok() { "success" } else { "error" });
                            let response = match result {
                                Ok(value) => {
                                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})
                                }
                                Err(error) => rpc_failure(&id, &tag, &payload, &error.to_string()),
                            };
                            let _ = request_tx.send(response).await;
                        });
                    }
                }
                _ => {}
            }
        }
    }
    cancel.cancel();
    for sub in subscriptions.values() {
        sub.cancel.cancel();
    }
    drop(tx);
    writer.abort();
    service
        .clients
        .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
}
