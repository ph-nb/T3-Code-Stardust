use super::{DEFAULTS, domain::Service, store::Document};
use serde_json::json;

#[tokio::test]
async fn reopening_keeps_history_and_interrupts_work_owned_by_the_previous_process() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    let state = directory.path().join("state");
    let service = Service::new(state.clone()).await.unwrap();
    let identity = service.store.environment_id.clone();
    service.project(json!({"type":"project.create","commandId":"project","projectId":"project","title":"recovery","workspaceRoot":workspace})).await.unwrap();
    service.create_thread(&json!({"commandId":"thread","threadId":"thread","projectId":"project","title":"recovery","modelSelection":{"instanceId":"codex","model":"default"}})).await.unwrap();
    let mut run = DEFAULTS["run"].clone();
    run["status"] = json!("running");
    let mut shell = service
        .store
        .read("shell", "thread")
        .await
        .unwrap()
        .unwrap();
    shell["activeRunId"] = json!("run");
    shell["status"] = json!("running");
    service
        .store
        .commit(
            "inflight",
            &[
                Document::new("run", "run", Some("thread"), run),
                Document::new("shell", "thread", Some("project"), shell),
                Document::new(
                    "item",
                    "message",
                    Some("thread"),
                    DEFAULTS["userItem"].clone(),
                ),
            ],
            &json!({"type":"fixture.inflight"}),
        )
        .await
        .unwrap();
    service.store.close().await;
    drop(service);
    let reopened = Service::new(state).await.unwrap();
    assert_eq!(reopened.store.environment_id, identity);
    let run = reopened.store.read("run", "run").await.unwrap().unwrap();
    assert_eq!(run["status"], "interrupted");
    let shell = reopened
        .store
        .read("shell", "thread")
        .await
        .unwrap()
        .unwrap();
    assert!(shell["activeRunId"].is_null());
    assert_eq!(
        reopened
            .store
            .list("item", Some("thread"))
            .await
            .unwrap()
            .len(),
        1
    );
    reopened.store.close().await;
}
