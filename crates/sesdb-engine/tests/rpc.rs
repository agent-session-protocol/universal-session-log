use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

struct Engine {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    dir: PathBuf,
}

impl Engine {
    fn start(tag: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("sesdb-engine-{tag}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_sesdb-engine"))
            .arg(dir.join("sesdb.usl"))
            .env("SESDB_TOKEN", TOKEN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            dir,
        }
    }

    fn request(&mut self, mut request: Value) -> Value {
        request
            .as_object_mut()
            .unwrap()
            .insert("token".into(), json!(TOKEN));
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn invalid_batch_does_not_append_a_valid_prefix() {
    let mut engine = Engine::start("atomic-batch");
    let response = engine.request(json!({
        "id": 1,
        "method": "appendBatch",
        "params": {"records": [
            {"sessionId": "aa".repeat(32), "kind": 1, "tsMs": 1, "body": [1]},
            {"sessionId": "bad", "kind": 1, "tsMs": 2, "body": [2]}
        ]}
    }));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_parameter");

    let scan = engine.request(json!({"id": 2, "method": "scan", "params": {"fromSeq": 0}}));
    assert_eq!(scan["result"]["nextSeq"], 0);
    assert_eq!(scan["result"]["records"].as_array().unwrap().len(), 0);
}

#[test]
fn rejects_missing_token_with_a_stable_error_code() {
    let mut engine = Engine::start("auth");
    writeln!(engine.input, "{}", json!({"id": 1, "method": "stats"})).unwrap();
    engine.input.flush().unwrap();
    let mut line = String::new();
    engine.output.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["error"]["code"], "permission_denied");
    assert_eq!(response["error"]["retryable"], false);
}

#[test]
fn rejects_non_durable_append_mode_without_writing() {
    let mut engine = Engine::start("durable-only");
    let response = engine.request(json!({
        "id": 1,
        "method": "appendBatch",
        "params": {"flush": false, "records": [
            {"sessionId": "aa".repeat(32), "kind": 1, "tsMs": 1, "body": [1]}
        ]}
    }));
    assert_eq!(response["error"]["code"], "unsupported_capability");
    let scan = engine.request(json!({"id": 2, "method": "scan"}));
    assert_eq!(scan["result"]["nextSeq"], 0);
}

#[test]
fn reports_tail_as_unsupported() {
    let mut engine = Engine::start("capabilities");
    let response = engine.request(json!({"id": 1, "method": "capabilities"}));
    assert_eq!(response["result"]["tailMode"], "unsupported");
    let tail = engine.request(json!({"id": 2, "method": "tail", "params": {"fromSeq": 0}}));
    assert_eq!(tail["error"]["code"], "unsupported_capability");
}

#[cfg(unix)]
#[test]
fn creates_store_and_lock_with_owner_only_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let mut engine = Engine::start("permissions");
    let _ = engine.request(json!({"id": 1, "method": "stats"}));
    let store_mode = std::fs::metadata(engine.dir.join("sesdb.usl"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    let lock_mode = std::fs::metadata(engine.dir.join("sesdb.usl.lock"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(store_mode, 0o600);
    assert_eq!(lock_mode, 0o600);
}

#[test]
fn refuses_a_second_writer_for_the_same_store() {
    let mut engine = Engine::start("exclusive-lock");
    let _ = engine.request(json!({"id": 1, "method": "stats"}));
    let mut second = Command::new(env!("CARGO_BIN_EXE_sesdb-engine"))
        .arg(engine.dir.join("sesdb.usl"))
        .env("SESDB_TOKEN", TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = second.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "second engine did not reject the locked store"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(!status.success());
}
