use crate::{
    RUNTIME_VERSION,
    config::{Config, Secret},
    protocol::{ClientMessage, RequestId, compatibility_inventory, failure, success},
    storage::{Cache, CreateProject, Database, StorageError, supervise_owner},
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    database: Database,
    cache: Cache,
    token: Secret,
    identity: String,
    shutdown: CancellationToken,
}

pub struct NativeServer {
    listener: Option<tokio::net::TcpListener>,
    router: Option<Router>,
    pub address: SocketAddr,
    pub shutdown: CancellationToken,
    owner_task: Option<tokio::task::JoinHandle<()>>,
}

impl NativeServer {
    pub async fn bind(config: Config) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        config.validate()?;
        let (database, owner) = Database::connect(&config).await?;
        let listener = tokio::net::TcpListener::bind(config.listen).await?;
        let address = listener.local_addr()?;
        let shutdown = CancellationToken::new();
        let state = Arc::new(AppState {
            database,
            cache: Cache::new(&config),
            token: config.token,
            identity: config.environment_id,
            shutdown: shutdown.clone(),
        });
        let owner_task = tokio::spawn(supervise_owner(owner, shutdown.clone()));
        let protected = Router::new()
            .route("/api/native/v1/capabilities", get(capabilities))
            .route(
                "/api/native/v1/projects",
                get(projects).post(create_project),
            )
            .route("/api/native/v1/events", get(events))
            .route("/ws", get(websocket))
            .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
        let mut router = Router::new()
            .route("/healthz", get(health))
            .merge(protected)
            .layer(DefaultBodyLimit::max(1024 * 1024))
            .with_state(state);
        if let Some(frontend) = config.frontend_dir {
            router = router.fallback_service(ServeDir::new(frontend));
        }
        Ok(Self {
            listener: Some(listener),
            router: Some(router),
            address,
            shutdown,
            owner_task: Some(owner_task),
        })
    }
    pub async fn run(mut self) -> std::io::Result<()> {
        let signal = self.shutdown.clone();
        let result = axum::serve(
            self.listener.take().expect("server listener"),
            self.router.take().expect("server router"),
        )
        .with_graceful_shutdown(async move { signal.cancelled().await })
        .await;
        self.shutdown.cancel();
        if let Some(owner) = self.owner_task.take() {
            let _ = owner.await;
        }
        result
    }
}

impl Drop for NativeServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn authorize(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if state.shutdown.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let authorized = request
        .headers()
        .get("authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| state.token.matches(value));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
            .into_response();
    }
    next.run(request).await
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let database = state.database.health().await;
    (
        if database {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(
            json!({"runtime":"rust","version":RUNTIME_VERSION,"preview":true,"clientProtocolCompatible":false,"database":database}),
        ),
    )
}

async fn capabilities(State(state): State<Arc<AppState>>) -> Json<Value> {
    let inventory = compatibility_inventory();
    Json(
        json!({"runtime":"rust","version":RUNTIME_VERSION,"environmentId":state.identity,"preview":true,"clientProtocolCompatible":false,"redisAvailable":state.cache.available().await,"legacyRpcCount":inventory["rpcs"].as_array().map_or(0, Vec::len),"desktopBridgeMethodCount":inventory["desktopMethods"].as_array().map_or(0, Vec::len),"features":["postgres-schema-105","environment-owner","atomic-project-commit","command-deduplication","event-cursor","effect-rpc-envelope"]}),
    )
}

async fn projects(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"projects":state.database.projects().await?})))
}

async fn create_project(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateProject>,
) -> Result<Json<Value>, ApiError> {
    if input.title.trim().is_empty()
        || input.title.len() > 1024
        || input.workspace_root.trim().is_empty()
        || input.workspace_root.len() > 32768
    {
        return Err(ApiError::Invalid);
    }
    Ok(Json(json!(state.database.create_project(&input).await?)))
}

#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(state): State<Arc<AppState>>,
    Query(cursor): Query<Cursor>,
) -> Result<Json<Value>, ApiError> {
    if cursor.after < 0 {
        return Err(ApiError::Invalid);
    }
    Ok(Json(
        json!({"events":state.database.events(cursor.after).await?}),
    ))
}

async fn websocket(
    State(state): State<Arc<AppState>>,
    upgrade: WebSocketUpgrade,
    headers: HeaderMap,
) -> impl IntoResponse {
    let _ = headers;
    upgrade
        .max_message_size(1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut writer, mut reader) = socket.split();
    loop {
        let message = tokio::select! {
            _ = state.shutdown.cancelled() => {let _ = writer.send(Message::Close(None)).await; break;},
            message = reader.next() => message,
        };
        let Some(Ok(message)) = message else { break };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            } else {
                continue;
            }
        };
        let response = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::Ping) => json!({"_tag":"Pong"}),
            Ok(ClientMessage::Request {
                id, tag, payload, ..
            }) => match tag.as_str() {
                "runtime.projects.list" => match state.database.projects().await {
                    Ok(value) => success(id, json!({"projects":value})),
                    Err(_) => failure(id, "StorageUnavailable", "database unavailable"),
                },
                "runtime.events.list" => match state
                    .database
                    .events(
                        payload
                            .get("after")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .max(0),
                    )
                    .await
                {
                    Ok(value) => success(id, json!({"events":value})),
                    Err(_) => failure(id, "StorageUnavailable", "database unavailable"),
                },
                _ => failure(id, "NotMigrated", "this RPC has not been migrated to Rust"),
            },
            Ok(ClientMessage::Eof) => break,
            Ok(ClientMessage::Ack { .. } | ClientMessage::Interrupt { .. }) => continue,
            Err(_) => failure(
                RequestId::String("invalid".into()),
                "InvalidRequest",
                "invalid RPC envelope",
            ),
        };
        if writer
            .send(Message::Text(response.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

enum ApiError {
    Storage(StorageError),
    Invalid,
}
impl From<StorageError> for ApiError {
    fn from(value: StorageError) -> Self {
        Self::Storage(value)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid input"})),
            )
                .into_response(),
            Self::Storage(StorageError::CommandReuse) => (
                StatusCode::CONFLICT,
                Json(json!({"error":"command identifier conflict"})),
            )
                .into_response(),
            Self::Storage(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"storage unavailable"})),
            )
                .into_response(),
        }
    }
}
