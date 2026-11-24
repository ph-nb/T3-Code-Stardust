use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn compatibility_inventory() -> &'static Value {
    static INVENTORY: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../schema/client-contracts.json"))
            .expect("generated client compatibility inventory must be valid JSON")
    });
    &INVENTORY
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ClientMessage {
    Request {
        id: RequestId,
        tag: String,
        #[serde(default)]
        payload: Value,
        #[serde(default)]
        headers: Vec<(String, String)>,
    },
    Ack {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Ping,
    Eof,
}

pub fn success(id: RequestId, value: Value) -> Value {
    serde_json::json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})
}

pub fn failure(id: RequestId, tag: &str, message: &str) -> Value {
    serde_json::json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":tag,"message":message}}]}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_effect_rpc_identifiers_and_failure_envelopes() {
        for id in [serde_json::json!(42), serde_json::json!("42")] {
            let input = serde_json::json!({"_tag":"Request","id":id,"tag":"server.probe","payload":{},"headers":[],"traceId":"trace"});
            let ClientMessage::Request { id: parsed, .. } = serde_json::from_value(input).unwrap()
            else {
                panic!()
            };
            let encoded = success(parsed, serde_json::json!({"ok":true}));
            assert_eq!(encoded["requestId"], id);
            assert_eq!(encoded["exit"]["_tag"], "Success");
        }
        let encoded = failure(
            RequestId::String("a".into()),
            "NotImplemented",
            "not migrated",
        );
        assert_eq!(
            encoded["exit"]["cause"][0]["error"]["_tag"],
            "NotImplemented"
        );
    }
}
