use super::{
    DEFAULTS,
    domain::{Change, Error, Service, string},
    now,
    store::Document,
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn ask(
    service: Arc<Service>,
    thread_id: &str,
    run: &Value,
    kind: &str,
    prompt: &str,
) -> Result<Value, Error> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let (send, receive) = tokio::sync::oneshot::channel();
    {
        let _guard = service.write_gate.lock().await;
        let mut request = DEFAULTS["runtimeRequest"].clone();
        request["id"] = json!(id);
        request["nodeId"] = run["id"].clone();
        request["kind"] = json!(kind);
        request["createdAt"] = json!(timestamp);
        request["responseCapability"]["providerSessionId"] =
            json!(format!("native-codex-{}", run["id"].as_str().unwrap_or("")));
        let mut item = DEFAULTS["approvalItem"].clone();
        item["id"] = json!(format!("approval-{id}"));
        item["threadId"] = json!(thread_id);
        item["runId"] = run["id"].clone();
        item["requestId"] = json!(id);
        item["requestKind"] = json!(kind);
        item["prompt"] = json!(prompt);
        item["status"] = json!("running");
        item["startedAt"] = json!(timestamp);
        item["completedAt"] = Value::Null;
        item["updatedAt"] = json!(timestamp);
        let mut shell = service
            .store
            .read("shell", thread_id)
            .await?
            .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
        item["ordinal"] = shell["itemCount"].clone();
        shell["itemCount"] = json!(shell["itemCount"].as_u64().unwrap_or(0) + 1);
        shell["visibleItemCount"] = shell["itemCount"].clone();
        shell["pendingRuntimeRequest"] = json!({"id":id,"kind":kind,"createdAt":timestamp});
        service.responses.lock().await.insert(id.clone(), send);
        let result = service
            .store
            .commit(
                &super::token(),
                &[
                    Document::new("request", &id, Some(thread_id), request),
                    Document::new(
                        "request-run",
                        &id,
                        run["id"].as_str(),
                        json!({"requestId":id,"threadId":thread_id}),
                    ),
                    Document::new(
                        "item",
                        item["id"].as_str().unwrap_or(""),
                        Some(thread_id),
                        item.clone(),
                    ),
                    Document::new("shell", thread_id, None, shell.clone()),
                ],
                &json!({"type":"runtime-request.created","threadId":thread_id}),
            )
            .await?;
        let sequence = result["sequence"].as_i64().unwrap_or(0);
        let _=service.changed.send(Change{sequence,shell:Some(json!({"kind":"thread.updated","sequence":sequence,"location":"active","thread":shell})),thread_id:Some(thread_id.into()),event:None,snapshot:true,config:false});
    }
    receive
        .await
        .map_err(|_| Error::Invalid("Approval request is no longer active".into()))
}

pub(super) async fn answer(service: Arc<Service>, input: Value) -> Result<Value, Error> {
    let _guard = service.write_gate.lock().await;
    let command_id = string(&input, "commandId")?;
    if let Some(receipt) = service.store.receipt(command_id).await? {
        return Ok(receipt);
    }
    let id = string(&input, "requestId")?;
    let thread_id = string(&input, "threadId")?;
    let decision = string(&input, "decision")?;
    if !matches!(
        decision,
        "accept" | "acceptForSession" | "decline" | "cancel"
    ) {
        return Err(Error::Invalid("Unsupported approval decision".into()));
    }
    let mappings = service.store.list("request", Some(thread_id)).await?;
    let mut request = mappings
        .into_iter()
        .find(|request| request["id"] == id)
        .ok_or_else(|| Error::Missing("Unknown approval request".into()))?;
    if request["status"] != "pending" || !service.responses.lock().await.contains_key(id) {
        return Err(Error::Invalid(
            "Approval request is no longer active".into(),
        ));
    }
    request["status"] = json!("resolved");
    request["resolvedAt"] = json!(now());
    request["decision"] = json!(decision);
    let mut item = service
        .store
        .read("item", &format!("approval-{id}"))
        .await?
        .ok_or_else(|| Error::Missing("Unknown approval item".into()))?;
    item["status"] = json!("completed");
    item["completedAt"] = json!(now());
    item["updatedAt"] = json!(now());
    let mut shell = service
        .store
        .read("shell", thread_id)
        .await?
        .ok_or_else(|| Error::Missing("Unknown thread".into()))?;
    shell["pendingRuntimeRequest"] = Value::Null;
    let result = service
        .store
        .commit(
            command_id,
            &[
                Document::new("request", id, Some(thread_id), request),
                Document::new(
                    "item",
                    item["id"].as_str().unwrap_or(""),
                    Some(thread_id),
                    item.clone(),
                ),
                Document::new("shell", thread_id, None, shell.clone()),
            ],
            &json!({"type":"runtime-request.answered","threadId":thread_id}),
        )
        .await?;
    let sequence = result["sequence"].as_i64().unwrap_or(0);
    let _ = service.changed.send(Change {
        sequence,
        shell: Some(
            json!({"kind":"thread.updated","sequence":sequence,"location":"active","thread":shell}),
        ),
        thread_id: Some(thread_id.into()),
        event: None,
        snapshot: true,
        config: false,
    });
    if let Some(send) = service.responses.lock().await.remove(id) {
        let _ = send.send(json!({"decision":decision}));
    }
    Ok(result)
}

pub(super) async fn close(service: &Service, run_id: &str) -> Result<(), Error> {
    let _guard = service.write_gate.lock().await;
    for mapping in service.store.list("request-run", Some(run_id)).await? {
        let id = mapping["requestId"].as_str().unwrap_or("");
        let thread_id = mapping["threadId"].as_str().unwrap_or("");
        service.responses.lock().await.remove(id);
        if let Some(mut request) = service.store.read("request", id).await? {
            if request["status"] != "pending" {
                continue;
            }
            request["status"] = json!("cancelled");
            request["resolvedAt"] = json!(now());
            let mut documents = vec![Document::new("request", id, Some(thread_id), request)];
            if let Some(mut item) = service
                .store
                .read("item", &format!("approval-{id}"))
                .await?
            {
                item["status"] = json!("completed");
                item["completedAt"] = json!(now());
                documents.push(Document::new(
                    "item",
                    item["id"].as_str().unwrap_or(""),
                    Some(thread_id),
                    item.clone(),
                ));
            }
            let result = service
                .store
                .commit(
                    &super::token(),
                    &documents,
                    &json!({"type":"runtime-request.cancelled","threadId":thread_id}),
                )
                .await?;
            let _ = service.changed.send(Change {
                sequence: result["sequence"].as_i64().unwrap_or(0),
                shell: None,
                thread_id: Some(thread_id.into()),
                event: None,
                snapshot: true,
                config: false,
            });
        }
    }
    Ok(())
}
