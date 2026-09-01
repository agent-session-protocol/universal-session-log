use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use usl_core::{Record, SessionId, Store, StoreOpts};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_RECORDS: usize = 10_000;
const MAX_BATCH_BYTES: usize = 1024 * 1024;
const DEFAULT_SCAN_LIMIT: usize = 1_000;
const MAX_SCAN_LIMIT: usize = 10_000;

#[derive(Deserialize)]
struct Request {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
    token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: &'static str,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl RpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

#[derive(Serialize)]
struct Response {
    id: Option<Value>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

fn session_id(value: &Value) -> Result<SessionId, RpcError> {
    let text = value
        .as_str()
        .ok_or_else(|| RpcError::new("invalid_parameter", "sessionId must be a hex string"))?;
    if text.len() != 64 {
        return Err(RpcError::new(
            "invalid_parameter",
            "sessionId must contain 64 hex characters",
        ));
    }
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| RpcError::new("invalid_parameter", "sessionId contains invalid hex"))?;
    }
    Ok(SessionId(bytes))
}

fn record(value: &Value) -> Result<Record, RpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| RpcError::new("invalid_parameter", "record must be an object"))?;
    let body = object
        .get("body")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::new("invalid_parameter", "body must be a byte array"))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|number| u8::try_from(number).ok())
                .ok_or_else(|| RpcError::new("invalid_parameter", "body contains an invalid byte"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Record::new(
        session_id(
            object
                .get("sessionId")
                .ok_or_else(|| RpcError::new("invalid_parameter", "sessionId is required"))?,
        )?,
        object
            .get("kind")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::new("invalid_parameter", "kind is required"))
            .and_then(|number| {
                u8::try_from(number)
                    .map_err(|_| RpcError::new("invalid_parameter", "kind must fit in a byte"))
            })?,
        object
            .get("tsMs")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::new("invalid_parameter", "tsMs is required"))?,
        body,
    ))
}

fn stored(record: &usl_core::StoredRecord) -> Value {
    json!({"seq": record.seq, "sessionId": record.session_id.to_hex(), "kind": record.kind, "tsMs": record.ts_ms, "body": record.body})
}

fn store_path() -> PathBuf {
    std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("SESDB_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("sesdb.usl"))
}

fn acquire_lock(path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600))?;
    }
    lock.try_lock_exclusive().map_err(|error| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("SESDB store is already owned by another engine: {error}"),
        )
    })?;
    Ok(lock)
}

fn write_response(response: &Response) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string(response)?);
    io::stdout().flush()?;
    Ok(())
}

fn read_request_line(reader: &mut impl BufRead) -> io::Result<Option<Result<String, RpcError>>> {
    let mut bytes = Vec::new();
    let mut overflow = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() && !overflow {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content_length = newline.unwrap_or(available.len());
        if !overflow {
            if bytes.len() + content_length > MAX_REQUEST_BYTES {
                overflow = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..content_length]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }
    if overflow {
        return Ok(Some(Err(RpcError::new(
            "resource_limit",
            "request exceeds the maximum NDJSON line size",
        ))));
    }
    Ok(Some(String::from_utf8(bytes).map_err(|_| {
        RpcError::new("parse_error", "request is not valid UTF-8")
    })))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = store_path();
    let expected_token = std::env::var("SESDB_TOKEN").map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SESDB_TOKEN is required to start sesdb-engine",
        )
    })?;
    if expected_token.len() < 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SESDB_TOKEN must contain at least 32 characters",
        )
        .into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _lock = acquire_lock(&path)?;
    let mut store = if path.exists() {
        Store::open(&path, StoreOpts::default())?
    } else {
        let store = Store::create(&path, StoreOpts::default())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        store
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }

    let mut input = io::stdin().lock();
    loop {
        let line = match read_request_line(&mut input)? {
            None => break,
            Some(Ok(line)) => line,
            Some(Err(error)) => {
                write_response(&Response {
                    id: None,
                    ok: false,
                    result: None,
                    error: Some(error),
                })?;
                continue;
            }
        };
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => {
                write_response(&Response {
                    id: None,
                    ok: false,
                    result: None,
                    error: Some(RpcError::new("parse_error", "invalid JSON request")),
                })?;
                continue;
            }
        };
        let id = request.id.clone();
        let result = if request.token.as_deref() != Some(expected_token.as_str()) {
            Err(RpcError::new("permission_denied", "unauthorized"))
        } else {
            dispatch(&mut store, &path, &request)
        };
        write_response(&match result {
            Ok(result) => Response {
                id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                id,
                ok: false,
                result: None,
                error: Some(error),
            },
        })?;
    }
    Ok(())
}

fn scan_limit(params: &Value) -> Result<usize, RpcError> {
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SCAN_LIMIT as u64);
    if limit == 0 || limit > MAX_SCAN_LIMIT as u64 {
        return Err(RpcError::new(
            "resource_limit",
            format!("limit must be between 1 and {MAX_SCAN_LIMIT}"),
        ));
    }
    Ok(limit as usize)
}

fn dispatch(store: &mut Store, path: &Path, request: &Request) -> Result<Value, RpcError> {
    let params = request.params.as_ref().unwrap_or(&Value::Null);
    match request.method.as_str() {
        "appendBatch" => {
            if params.get("flush") == Some(&Value::Bool(false)) {
                return Err(RpcError::new(
                    "unsupported_capability",
                    "appendBatch always confirms durability; flush=false is not supported",
                ));
            }
            let values = params
                .get("records")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::new("invalid_parameter", "records must be an array"))?;
            if values.len() > MAX_BATCH_RECORDS {
                return Err(RpcError::new(
                    "resource_limit",
                    format!("batch exceeds {MAX_BATCH_RECORDS} records"),
                ));
            }
            let records = values.iter().map(record).collect::<Result<Vec<_>, _>>()?;
            let body_bytes: usize = records.iter().map(|record| record.body.len()).sum();
            if body_bytes > MAX_BATCH_BYTES {
                return Err(RpcError::new("resource_limit", "batch body exceeds 1 MiB"));
            }
            let seqs = store
                .append_batch(&records)
                .map_err(|error| RpcError::new("storage_error", error.to_string()).retryable())?;
            store.flush().map_err(|error| {
                RpcError::new(
                    "durability_unknown",
                    "records were appended but the durability barrier failed",
                )
                .details(json!({"seqs": seqs, "cause": error.to_string()}))
            })?;
            Ok(json!({"seqs": seqs, "nextSeq": store.next_seq()}))
        }
        "scan" => {
            let from_seq = params.get("fromSeq").and_then(Value::as_u64).unwrap_or(0);
            let limit = scan_limit(params)?;
            let records = if let Some(session) = params.get("sessionId") {
                store
                    .scan_limited(&session_id(session)?, from_seq, limit + 1)
                    .map_err(|error| RpcError::new("storage_error", error.to_string()))?
            } else {
                store
                    .scan_all_limited(from_seq, limit + 1)
                    .map_err(|error| RpcError::new("storage_error", error.to_string()))?
            };
            let has_more = records.len() > limit;
            let mut records = records;
            records.truncate(limit);
            Ok(json!({
                "records": records.iter().map(stored).collect::<Vec<_>>(),
                "nextSeq": store.next_seq(),
                "nextFromSeq": records.last().map(|record| record.seq + 1).unwrap_or(from_seq),
                "hasMore": has_more,
            }))
        }
        "tail" => Err(RpcError::new(
            "unsupported_capability",
            "live tail is not implemented; use bounded scan replay",
        )),
        "verify" => {
            let report = Store::verify(path)
                .map_err(|error| RpcError::new("storage_error", error.to_string()))?;
            Ok(
                json!({"dataEnd": report.data_end, "nextSeq": report.next_seq, "sessionCount": report.session_count, "frameCount": report.frame_count, "truncationOffset": report.truncation_offset}),
            )
        }
        "stats" => Ok(
            json!({"nextSeq": store.next_seq(), "sessionCount": store.session_count(), "dataEnd": store.data_end()}),
        ),
        "flush" => {
            store
                .flush()
                .map_err(|error| RpcError::new("storage_error", error.to_string()).retryable())?;
            Ok(json!({"nextSeq": store.next_seq()}))
        }
        "capabilities" => Ok(json!({
            "rpcVersion": "sesdb.engine/v1",
            "methods": ["appendBatch", "scan", "verify", "stats", "flush", "capabilities"],
            "tailMode": "unsupported",
            "maxBatchRecords": MAX_BATCH_RECORDS,
            "maxBatchBytes": MAX_BATCH_BYTES,
            "maxScanLimit": MAX_SCAN_LIMIT,
        })),
        _ => Err(RpcError::new(
            "unsupported_capability",
            format!("unknown method: {}", request.method),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_discards_an_oversized_line_and_recovers() {
        let mut input = vec![b'x'; MAX_REQUEST_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = Cursor::new(input);
        let first = read_request_line(&mut reader)
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(first.code, "resource_limit");
        assert_eq!(
            read_request_line(&mut reader).unwrap().unwrap().unwrap(),
            "{}"
        );
    }
}
