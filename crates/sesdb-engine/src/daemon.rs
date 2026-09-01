use crate::index::Sidecar;
use crate::model::*;
use crate::provider::{
    adapter, canonical_id, complete_offset, event_digest, fingerprints, is_append, session_id,
    snapshot, ProviderKind,
};
use crate::{canonical_session_id, Paths, LOCAL_API_VERSION, RPC_VERSION};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use fs2::FileExt;
use notify::{RecursiveMode, Watcher as NotifyWatcher};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use usl_core::{Record, SessionId, Store, StoreOpts, StoredRecord};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub enabled: bool,
    pub roots: Vec<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub providers: BTreeMap<String, ProviderConfig>,
}

impl Default for Config {
    fn default() -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            providers: BTreeMap::from([
                (
                    "claude".into(),
                    ProviderConfig {
                        enabled: false,
                        roots: vec![home.join(".claude/projects")],
                    },
                ),
                (
                    "codex".into(),
                    ProviderConfig {
                        enabled: false,
                        roots: vec![home.join(".codex/sessions")],
                    },
                ),
            ]),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub api_version: String,
    pub base_url: String,
    pub token: String,
    pub pid: u32,
    pub started_at_ms: u64,
}

pub struct Writer {
    pub paths: Paths,
    pub store: Store,
    pub sidecar: Sidecar,
    pub config: Config,
    pub degraded: bool,
    replay: ReplayState,
    hot_files: Vec<HotSource>,
    last_inventory_ms: u64,
    missing_since: BTreeMap<(String, String), u64>,
    _lock: File,
}

const MAX_HOT_FILES: usize = 64;
const INVENTORY_AUDIT_MS: u64 = 30_000;

#[derive(Clone)]
struct HotSource {
    provider: ProviderKind,
    path: PathBuf,
    modified_ms: u64,
}

#[derive(Default)]
struct ReplayState {
    event_ids: HashSet<String>,
    sources: BTreeMap<(String, String), SourceCheckpoint>,
    hidden_generations: HashSet<(String, String, u64)>,
}

impl ReplayState {
    fn load(store: &Store) -> Result<Self, String> {
        let mut state = Self::default();
        for record in store.scan_all(0).map_err(|e| e.to_string())? {
            state.apply(&record);
        }
        Ok(state)
    }

    fn apply(&mut self, record: &StoredRecord) {
        match record.kind {
            KIND_CANONICAL_EVENT => {
                if let Ok(body) = serde_json::from_slice::<CanonicalEventBody>(&record.body) {
                    self.event_ids.insert(body.event_id);
                }
            }
            KIND_SOURCE_CHECKPOINT => {
                if let Ok(checkpoint) = serde_json::from_slice::<SourceCheckpoint>(&record.body) {
                    self.sources.insert(
                        (checkpoint.provider.clone(), checkpoint.source_path.clone()),
                        checkpoint,
                    );
                }
            }
            KIND_VISIBILITY => {
                if let Ok(control) = serde_json::from_slice::<VisibilityControl>(&record.body) {
                    self.hidden_generations.insert((
                        control.provider,
                        control.source_path,
                        control.source_generation,
                    ));
                }
            }
            _ => {}
        }
    }

    fn source(&self, provider: &str, path: &str) -> Option<&SourceCheckpoint> {
        self.sources.get(&(provider.to_owned(), path.to_owned()))
    }

    fn source_paths(&self, provider: &str) -> Vec<String> {
        self.sources
            .keys()
            .filter(|(candidate, _)| candidate == provider)
            .map(|(_, path)| path.clone())
            .collect()
    }
}

impl Writer {
    pub fn open(paths: Paths) -> Result<Self, String> {
        std::fs::create_dir_all(&paths.home).map_err(|e| e.to_string())?;
        set_dir_private(&paths.home).map_err(|e| e.to_string())?;
        let lock_path = PathBuf::from(format!("{}.lock", paths.log.display()));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| e.to_string())?;
        set_file_private(&lock_path).map_err(|e| e.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|e| format!("SESDB store is already owned by another writer: {e}"))?;
        let store = if paths.log.exists() {
            Store::open(&paths.log, StoreOpts::default())
        } else {
            Store::create(&paths.log, StoreOpts::default())
        }
        .map_err(|e| e.to_string())?;
        set_file_private(&paths.log).map_err(|e| e.to_string())?;
        let replay = ReplayState::load(&store)?;
        let sidecar = Sidecar::open_or_rebuild(&paths.sqlite, &store)?;
        let config = if paths.config.exists() {
            serde_json::from_slice(&std::fs::read(&paths.config).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            let value = Config::default();
            write_json_atomic(&paths.config, &value).map_err(|e| e.to_string())?;
            value
        };
        Ok(Self {
            paths,
            store,
            sidecar,
            config,
            degraded: false,
            replay,
            hot_files: Vec::new(),
            last_inventory_ms: 0,
            missing_since: BTreeMap::new(),
            _lock: lock,
        })
    }

    pub fn enable(&mut self, provider: ProviderKind, root: Option<PathBuf>) -> Result<(), String> {
        let config = self
            .config
            .providers
            .get_mut(provider.name())
            .ok_or("provider config missing")?;
        config.enabled = true;
        if let Some(root) = root {
            config.roots = vec![root];
        }
        write_json_atomic(&self.paths.config, &self.config).map_err(|e| e.to_string())
    }
    pub fn disable(&mut self, provider: ProviderKind) -> Result<(), String> {
        self.config
            .providers
            .get_mut(provider.name())
            .ok_or("provider config missing")?
            .enabled = false;
        write_json_atomic(&self.paths.config, &self.config).map_err(|e| e.to_string())
    }

    pub fn discover(&self, selected: Option<ProviderKind>) -> Result<Value, String> {
        let mut results = Vec::new();
        for kind in [ProviderKind::Claude, ProviderKind::Codex] {
            if selected.is_some() && selected != Some(kind) {
                continue;
            }
            let config = &self.config.providers[kind.name()];
            results.extend(adapter(kind).discover(&config.roots)?);
        }
        Ok(json!({"sources":results,"contentRead":false}))
    }

    pub fn reconcile(&mut self, selected: Option<ProviderKind>) -> Result<Value, String> {
        self.reconcile_at(selected, now_ms())
    }

    fn reconcile_at(
        &mut self,
        selected: Option<ProviderKind>,
        reconciliation_ms: u64,
    ) -> Result<Value, String> {
        self.ensure_projection()?;
        let mut sources = 0;
        let mut events = 0;
        let mut errors = Vec::new();
        for kind in [ProviderKind::Claude, ProviderKind::Codex] {
            if selected.is_some() && selected != Some(kind) {
                continue;
            }
            let config = self.config.providers[kind.name()].clone();
            if !config.enabled {
                continue;
            }
            let adapter = adapter(kind);
            let discovered = adapter.discover(&config.roots)?;
            let seen = discovered
                .iter()
                .map(|source| source.path.clone())
                .collect::<HashSet<_>>();
            for source in discovered {
                sources += 1;
                self.remember_hot(kind, PathBuf::from(&source.path), source.modified_ms);
                let force_replacement = self
                    .missing_since
                    .remove(&(kind.name().into(), source.path.clone()))
                    == Some(u64::MAX);
                match self.reconcile_file(kind, Path::new(&source.path), force_replacement) {
                    Ok(count) => events += count,
                    Err(error) => errors
                        .push(json!({"provider":kind.name(),"path":source.path,"error":error})),
                }
            }
            for path in self.replay.source_paths(kind.name()) {
                if seen.contains(&path) {
                    continue;
                }
                let key = (kind.name().to_string(), path.clone());
                let missing = *self
                    .missing_since
                    .entry(key.clone())
                    .or_insert(reconciliation_ms);
                if missing == u64::MAX {
                    continue;
                }
                if reconciliation_ms.saturating_sub(missing) >= 5_000 {
                    if let Err(error) = self.retract_missing(kind, &path) {
                        errors.push(json!({"provider":kind.name(),"path":path,"error":error}));
                    }
                    self.missing_since.insert(key, u64::MAX);
                }
            }
        }
        if selected.is_none() {
            self.last_inventory_ms = reconciliation_ms;
        }
        Ok(
            json!({"sources":sources,"events":events,"errors":errors,"degraded":self.degraded,"asOfSeq":self.store.next_seq()}),
        )
    }

    fn remember_hot(&mut self, provider: ProviderKind, path: PathBuf, modified_ms: u64) {
        self.hot_files
            .retain(|source| !(source.provider == provider && source.path == path));
        self.hot_files.push(HotSource {
            provider,
            path,
            modified_ms,
        });
        self.hot_files.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.path.cmp(&b.path))
        });
        self.hot_files.truncate(MAX_HOT_FILES);
    }

    fn provider_for_path(&self, path: &Path) -> Option<ProviderKind> {
        [ProviderKind::Claude, ProviderKind::Codex]
            .into_iter()
            .find(|kind| {
                self.config.providers[kind.name()].enabled
                    && self.config.providers[kind.name()]
                        .roots
                        .iter()
                        .any(|root| path.starts_with(root))
            })
    }

    pub fn watch_tick(&mut self, hints: Vec<PathBuf>) -> Result<Value, String> {
        self.watch_tick_at(hints, now_ms())
    }

    fn watch_tick_at(&mut self, hints: Vec<PathBuf>, tick_ms: u64) -> Result<Value, String> {
        self.ensure_projection()?;
        if self.last_inventory_ms == 0
            || tick_ms.saturating_sub(self.last_inventory_ms) >= INVENTORY_AUDIT_MS
        {
            return self.reconcile_at(None, tick_ms);
        }

        let mut candidates = self
            .hot_files
            .iter()
            .map(|source| (source.provider, source.path.clone()))
            .collect::<Vec<_>>();
        for path in hints {
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(provider) = self.provider_for_path(&path) {
                candidates.push((provider, path));
            }
        }
        candidates.sort_by(|a, b| a.1.cmp(&b.1));
        candidates.dedup();
        let mut events = 0;
        let mut errors = Vec::new();
        for (provider, path) in candidates {
            if !path.exists() {
                continue;
            }
            match self.reconcile_file(provider, &path, false) {
                Ok(count) => events += count,
                Err(error) => errors.push(json!({
                    "provider": provider.name(),
                    "path": path,
                    "error": error
                })),
            }
        }
        Ok(
            json!({"sources":self.hot_files.len(),"events":events,"errors":errors,"degraded":self.degraded,"audit":false,"asOfSeq":self.store.next_seq()}),
        )
    }

    fn reconcile_file(
        &mut self,
        provider: ProviderKind,
        path: &Path,
        force_replacement: bool,
    ) -> Result<usize, String> {
        let bytes = snapshot(path)?;
        let completed = complete_offset(&bytes);
        let complete = &bytes[..completed];
        let path_text = path.to_string_lossy().into_owned();
        let previous = self.replay.source(provider.name(), &path_text).cloned();
        let (old_generation, old_offset, old_length, old_chunks) = previous
            .as_ref()
            .map(|value| {
                (
                    value.generation,
                    value.committed_offset,
                    value.snapshot_length,
                    value.chunks.clone(),
                )
            })
            .unwrap_or((0, 0, 0, Vec::new()));
        let append =
            !force_replacement && previous.is_some() && is_append(old_length, &old_chunks, &bytes);
        if previous.is_some() && append && completed as u64 <= old_offset {
            return Ok(0);
        }
        let generation = if previous.is_none() {
            1
        } else if append {
            old_generation
        } else {
            old_generation + 1
        };
        let from = if append { old_offset } else { 0 };
        let parsed = adapter(provider).parse_snapshot(path, complete, from)?;
        let control = if previous.is_some() && !append {
            Some(VisibilityControl {
                version: 1,
                action: VisibilityAction::Supersede,
                provider: provider.name().into(),
                source_path: path_text.clone(),
                source_generation: old_generation,
                reason: "source content changed".into(),
            })
        } else {
            None
        };
        let mut records = Vec::new();
        if let Some(control) = control {
            records.push(Record::new(
                parse_id(&canonical_session_id(provider.name(), &path_text))?,
                KIND_VISIBILITY,
                now_ms(),
                serde_json::to_vec(&control).map_err(|e| e.to_string())?,
            ));
        }
        let mut accepted = 0;
        for native in parsed {
            let id = canonical_id(provider, &native, generation);
            if self.replay.event_ids.contains(&id) {
                continue;
            }
            let sid = session_id(provider, &native.native_session_id);
            let sid_bytes = parse_id(&sid)?;
            let evidence_seq = self.store.next_seq() + records.len() as u64;
            let raw_digest = event_digest(&native);
            let evidence = NativeEvidence {
                version: 1,
                provider: provider.name().into(),
                source_path: path_text.clone(),
                source_generation: generation,
                byte_start: native.byte_start,
                byte_end: native.byte_end,
                sha256: raw_digest.clone(),
                raw: native.raw,
            };
            records.push(Record::new(
                sid_bytes,
                KIND_EVIDENCE,
                native.timestamp_ms,
                serde_json::to_vec(&evidence).map_err(|e| e.to_string())?,
            ));
            let timestamp = chrono::DateTime::from_timestamp_millis(native.timestamp_ms as i64)
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
            let pointer = json!({"sessionId":sid,"eventId":id,"sourcePath":path_text,"sourceDigest":raw_digest,"byteStart":native.byte_start,"byteEnd":native.byte_end,"parserVersion":format!("{}@1",provider.name())});
            let canonical_event = json!({"schemaVersion":"1.0","eventId":id,"sessionId":sid,"type":native.event_type,"timestamp":timestamp,"timestampMs":native.timestamp_ms,"payload":native.event});
            let body = CanonicalEventBody {
                version: 1,
                provider: provider.name().into(),
                native_session_id: native.native_session_id,
                source_path: path_text.clone(),
                source_generation: generation,
                event_id: id,
                native_identity: native.native_identity,
                entity_revision: native.entity_revision,
                event: canonical_event,
                evidence: Some(pointer),
                evidence_seqs: vec![evidence_seq],
            };
            records.push(Record::new(
                sid_bytes,
                KIND_CANONICAL_EVENT,
                native.timestamp_ms,
                serde_json::to_vec(&body).map_err(|e| e.to_string())?,
            ));
            accepted += 1;
        }
        let checkpoint = SourceCheckpoint {
            version: 1,
            provider: provider.name().into(),
            source_path: path_text.clone(),
            generation,
            committed_offset: completed as u64,
            snapshot_length: bytes.len() as u64,
            chunks: fingerprints(&bytes),
        };
        records.push(Record::new(
            parse_id(&canonical_session_id(provider.name(), &path_text))?,
            KIND_SOURCE_CHECKPOINT,
            now_ms(),
            serde_json::to_vec(&checkpoint).map_err(|e| e.to_string())?,
        ));
        self.append_project(records)?;
        Ok(accepted)
    }

    pub fn retract_missing(&mut self, provider: ProviderKind, path: &str) -> Result<(), String> {
        if let Some(generation) = self
            .replay
            .source(provider.name(), path)
            .map(|value| value.generation)
        {
            let control = VisibilityControl {
                version: 1,
                action: VisibilityAction::Retract,
                provider: provider.name().into(),
                source_path: path.into(),
                source_generation: generation,
                reason: "source deleted after grace period".into(),
            };
            self.append_project(vec![Record::new(
                parse_id(&canonical_session_id(provider.name(), path))?,
                KIND_VISIBILITY,
                now_ms(),
                serde_json::to_vec(&control).map_err(|e| e.to_string())?,
            )])?;
        }
        Ok(())
    }

    fn append_project(&mut self, records: Vec<Record>) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        let seqs = self
            .store
            .append_batch(&records)
            .map_err(|e| e.to_string())?;
        self.store.flush().map_err(|e| e.to_string())?;
        let stored = records
            .iter()
            .zip(seqs)
            .map(|(record, seq)| StoredRecord::from_record(seq, record))
            .collect::<Vec<_>>();
        for record in &stored {
            self.replay.apply(record);
        }
        if let Err(error) = self.sidecar.project(&stored) {
            self.degraded = true;
            return Err(format!(
                "L1 committed but sidecar projection failed: {error}"
            ));
        }
        self.degraded = false;
        Ok(())
    }

    fn ensure_projection(&mut self) -> Result<(), String> {
        let status = self.sidecar.status(self.store.next_seq(), self.degraded);
        if !self.degraded && status.built_through_seq == self.store.next_seq() {
            return Ok(());
        }
        self.degraded = true;
        self.sidecar
            .repair_live(&self.store)
            .map_err(|error| format!("sidecar is degraded and automatic repair failed: {error}"))?;
        self.degraded = false;
        Ok(())
    }

    pub fn rebuild(&mut self) -> Result<Value, String> {
        self.sidecar.rebuild_live(&self.store)?;
        self.degraded = false;
        Ok(serde_json::to_value(self.sidecar.status(self.store.next_seq(), false)).unwrap())
    }
}

#[derive(Clone)]
struct AppState {
    writer: Arc<Mutex<Writer>>,
    token: String,
    read_token: String,
    browser_codes: Arc<Mutex<BTreeMap<String, u64>>>,
    allowed_authorities: Arc<HashSet<String>>,
    shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

const BROWSER_CODE_TTL_MS: u64 = 60_000;

pub async fn run(paths: Paths) -> Result<Descriptor, String> {
    let writer = Writer::open(paths.clone())?;
    let watch_roots = writer
        .config
        .providers
        .values()
        .flat_map(|provider| provider.roots.clone())
        .collect::<Vec<_>>();
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    let token = hex::encode(secret);
    rand::rng().fill_bytes(&mut secret);
    let read_token = hex::encode(secret);
    let descriptor = Descriptor {
        api_version: LOCAL_API_VERSION.into(),
        base_url: format!("http://{address}"),
        token: token.clone(),
        pid: std::process::id(),
        started_at_ms: now_ms(),
    };
    write_json_atomic(&paths.descriptor, &descriptor).map_err(|e| e.to_string())?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let state = AppState {
        writer: Arc::new(Mutex::new(writer)),
        token,
        read_token,
        browser_codes: Arc::new(Mutex::new(BTreeMap::new())),
        allowed_authorities: Arc::new(HashSet::from([
            format!("127.0.0.1:{}", address.port()),
            format!("localhost:{}", address.port()),
        ])),
        shutdown: Arc::new(Mutex::new(Some(shutdown_tx))),
    };
    let watcher_state = state.clone();
    let watcher_descriptor = paths.descriptor.clone();
    let watcher_hints = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let notify_hints = watcher_hints.clone();
    let mut notify_watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                if let Ok(mut hints) = notify_hints.lock() {
                    hints.extend(event.paths);
                }
            }
        })
        .ok();
    if let Some(watcher) = notify_watcher.as_mut() {
        for root in watch_roots.iter().filter(|root| root.exists()) {
            let _ = watcher.watch(root, RecursiveMode::Recursive);
        }
    }
    tokio::spawn(async move {
        let _notify_watcher = notify_watcher;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if !watcher_descriptor.exists() {
                break;
            }
            let hints = watcher_hints
                .lock()
                .map(|mut value| std::mem::take(&mut *value).into_iter().collect())
                .unwrap_or_default();
            let writer = watcher_state.writer.clone();
            let _ = tokio::task::spawn_blocking(move || {
                writer
                    .lock()
                    .ok()
                    .and_then(|mut value| value.watch_tick(hints).ok())
            })
            .await;
        }
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/capabilities", get(capabilities))
        .route("/providers", get(providers))
        .route("/providers/discover", get(discover_all))
        .route("/providers/{provider}/enable", post(enable))
        .route("/providers/{provider}/disable", post(disable))
        .route("/providers/{provider}/reconcile", post(reconcile_one))
        .route("/index/status", get(index_status))
        .route("/index/reconcile", post(reconcile_all))
        .route("/index/rebuild", post(rebuild))
        .route("/sessions", get(sessions))
        .route("/sessions/{id}", get(session))
        .route("/sessions/{id}/events", get(events))
        .route("/search", get(search))
        .route("/evidence/{seq}", get(evidence))
        .route("/rpc", post(rpc))
        .route("/daemon/stop", post(stop))
        .route("/browser-session", post(browser_session))
        .route("/auth/browser", get(browser_auth))
        .route("/console", get(console))
        .route("/console-mode.js", get(console_mode))
        .route("/universal-session-log/console-mode.js", get(console_mode))
        .fallback(get(static_asset))
        .with_state(state);
    let cleanup = paths.descriptor.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
        let _ = std::fs::remove_file(cleanup);
    });
    Ok(descriptor)
}

fn authorized(headers: &HeaderMap, state: &AppState, management: bool) -> Result<(), Response> {
    validate_local_request(headers, state)?;
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if bearer == Some(&state.token) {
        return Ok(());
    }
    if !management {
        if let Some(cookie) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
            if cookie
                .split(';')
                .any(|v| v.trim() == format!("sesdb_read={}", state.read_token))
            {
                return Ok(());
            }
        }
    }
    Err(api_error(
        StatusCode::UNAUTHORIZED,
        "permission_denied",
        "unauthorized",
    ))
}

fn validate_local_request(headers: &HeaderMap, state: &AppState) -> Result<(), Response> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(|value| state.allowed_authorities.contains(value)) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "permission_denied",
            "host is not allowed",
        ));
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let parsed = origin.parse::<Uri>().ok();
        let allowed = parsed.as_ref().is_some_and(|uri| {
            uri.scheme_str() == Some("http")
                && uri
                    .authority()
                    .is_some_and(|authority| state.allowed_authorities.contains(authority.as_str()))
                && uri.path() == "/"
                && uri.query().is_none()
        });
        if !allowed {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "permission_denied",
                "origin is not allowed",
            ));
        }
    }
    Ok(())
}
fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"code":code,"message":message,"details":{},"retryable":false})),
    )
        .into_response()
}
fn internal(error: String) -> Response {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", &error)
}
fn with_writer<T: Serialize>(
    headers: HeaderMap,
    state: AppState,
    management: bool,
    f: impl FnOnce(&mut Writer) -> Result<T, String>,
) -> Response {
    if let Err(r) = authorized(&headers, &state, management) {
        return r;
    }
    match state.writer.lock() {
        Ok(mut w) => match f(&mut w) {
            Ok(v) => Json(v).into_response(),
            Err(e) => internal(e),
        },
        Err(_) => internal("writer lock poisoned".into()),
    }
}
async fn health(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, false, |w| {
        Ok(
            json!({"ok":true,"apiVersion":LOCAL_API_VERSION,"degraded":w.degraded,"asOfSeq":w.store.next_seq()}),
        )
    })
}
async fn capabilities(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, false, |_| {
        Ok(
            json!({"apiVersion":LOCAL_API_VERSION,"rpcVersion":RPC_VERSION,"providers":["claude","codex"],"features":["fts5","evidence","rebuild","sessions"],"unavailable":["analytics","memory","semanticSearch","settings"]}),
        )
    })
}
async fn providers(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, false, |w| Ok(json!({"providers":w.config.providers})))
}
#[derive(Deserialize)]
struct DiscoverQuery {
    provider: Option<String>,
}
async fn discover_all(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(q): Query<DiscoverQuery>,
) -> Response {
    with_writer(h, s, false, |w| {
        let selected = match q.provider.as_deref() {
            Some(value) => Some(ProviderKind::parse(value).ok_or("unknown provider")?),
            None => None,
        };
        w.discover(selected)
    })
}
#[derive(Deserialize)]
struct RootBody {
    root: Option<PathBuf>,
}
async fn enable(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(p): AxumPath<String>,
    body: Option<Json<RootBody>>,
) -> Response {
    with_writer(h, s, true, |w| {
        let k = ProviderKind::parse(&p).ok_or("unknown provider")?;
        w.enable(k, body.and_then(|v| v.0.root))?;
        Ok(json!({"ok":true}))
    })
}
async fn disable(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(p): AxumPath<String>,
) -> Response {
    with_writer(h, s, true, |w| {
        w.disable(ProviderKind::parse(&p).ok_or("unknown provider")?)?;
        Ok(json!({"ok":true}))
    })
}
async fn reconcile_one(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(p): AxumPath<String>,
) -> Response {
    with_writer(h, s, true, |w| {
        w.reconcile(Some(ProviderKind::parse(&p).ok_or("unknown provider")?))
    })
}
async fn reconcile_all(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, true, |w| w.reconcile(None))
}
async fn index_status(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, false, |w| {
        Ok(w.sidecar.status(w.store.next_seq(), w.degraded))
    })
}
async fn rebuild(State(s): State<AppState>, h: HeaderMap) -> Response {
    with_writer(h, s, true, Writer::rebuild)
}
#[derive(Deserialize)]
struct ListQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}
async fn sessions(State(s): State<AppState>, h: HeaderMap, Query(q): Query<ListQuery>) -> Response {
    let token = s.token.clone();
    with_writer(h, s, false, move |w| {
        let limit = q.limit.unwrap_or(100).min(1000);
        let offset = cursor_offset(q.cursor.as_deref(), &token, "sessions", "", w)?;
        let value = w.sidecar.sessions(limit, offset)?;
        Ok(with_next_cursor(
            value, &token, "sessions", "", w, offset, limit,
        ))
    })
}
async fn session(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    with_writer(h, s, false, |w| {
        w.sidecar.session(&id)?.ok_or("session not found".into())
    })
}
#[derive(Deserialize)]
struct EventsQuery {
    limit: Option<usize>,
    history: Option<bool>,
    cursor: Option<String>,
}
async fn events(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<EventsQuery>,
) -> Response {
    let token = s.token.clone();
    with_writer(h, s, false, move |w| {
        let history = q.history.unwrap_or(false);
        let limit = q.limit.unwrap_or(1000).min(10000);
        let binding = format!("{id}:{history}");
        let offset = cursor_offset(q.cursor.as_deref(), &token, "events", &binding, w)?;
        let value = w.sidecar.events(&id, history, limit, offset)?;
        Ok(with_next_cursor(
            value, &token, "events", &binding, w, offset, limit,
        ))
    })
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
    history: Option<bool>,
    cursor: Option<String>,
}
async fn search(State(s): State<AppState>, h: HeaderMap, Query(q): Query<SearchQuery>) -> Response {
    let token = s.token.clone();
    with_writer(h, s, false, move |w| {
        let history = q.history.unwrap_or(false);
        let limit = q.limit.unwrap_or(100).min(1000);
        let binding = format!("{}:{history}", q.q);
        let offset = cursor_offset(q.cursor.as_deref(), &token, "search", &binding, w)?;
        let value = w.sidecar.search(&q.q, history, limit, offset)?;
        Ok(with_next_cursor(
            value, &token, "search", &binding, w, offset, limit,
        ))
    })
}
async fn evidence(
    State(s): State<AppState>,
    h: HeaderMap,
    AxumPath(seq): AxumPath<u64>,
) -> Response {
    with_writer(h, s, false, |w| {
        let record = w
            .store
            .scan_all_limited(seq, 1)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|r| r.seq == seq && r.kind == KIND_EVIDENCE)
            .ok_or("evidence not found")?;
        let body: NativeEvidence =
            serde_json::from_slice(&record.body).map_err(|e| e.to_string())?;
        Ok(
            json!({"seq":seq,"provider":body.provider,"sourcePath":body.source_path,"byteStart":body.byte_start,"byteEnd":body.byte_end,"sha256":body.sha256,"rawBase64":base64::engine::general_purpose::STANDARD.encode(body.raw)}),
        )
    })
}
#[derive(Deserialize)]
struct RpcRequest {
    method: String,
    params: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRecord {
    session_id: String,
    kind: u8,
    ts_ms: u64,
    body: Vec<u8>,
}
async fn rpc(State(s): State<AppState>, h: HeaderMap, Json(r): Json<RpcRequest>) -> Response {
    if matches!(r.method.as_str(), "appendBatch" | "flush") {
        if let Err(response) = authorized(&h, &s, true) {
            return response;
        }
    }
    with_writer(h, s, false, |w| match r.method.as_str() {
        "capabilities" => Ok(json!({"rpcVersion":RPC_VERSION})),
        "stats" => {
            let index = w.sidecar.status(w.store.next_seq(), w.degraded);
            Ok(
                json!({"nextSeq":w.store.next_seq(),"sessionCount":w.store.session_count(),"dataEnd":w.store.data_end(),"generation":index.generation,"builtThroughSeq":index.built_through_seq}),
            )
        }
        "verify" => {
            let v = Store::verify(&w.paths.log).map_err(|e| e.to_string())?;
            Ok(
                json!({"dataEnd":v.data_end,"nextSeq":v.next_seq,"sessionCount":v.session_count,"frameCount":v.frame_count,"truncationOffset":v.truncation_offset}),
            )
        }
        "appendBatch" => {
            let params = r.params.unwrap_or(Value::Null);
            if params.get("flush") == Some(&Value::Bool(false)) {
                return Err("appendBatch always confirms durability".into());
            }
            let values = params
                .get("records")
                .and_then(Value::as_array)
                .ok_or("records must be an array")?;
            if values.len() > 10_000 {
                return Err("batch exceeds 10000 records".into());
            }
            let parsed = values
                .iter()
                .map(|value| {
                    let value: RpcRecord =
                        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                    Ok(Record::new(
                        parse_id(&value.session_id)?,
                        value.kind,
                        value.ts_ms,
                        value.body,
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            if parsed.iter().map(|record| record.body.len()).sum::<usize>() > 1024 * 1024 {
                return Err("batch body exceeds 1 MiB".into());
            }
            let before = w.store.next_seq();
            w.append_project(parsed)?;
            Ok(
                json!({"seqs":(before..w.store.next_seq()).collect::<Vec<_>>(),"nextSeq":w.store.next_seq()}),
            )
        }
        "flush" => {
            w.store.flush().map_err(|e| e.to_string())?;
            Ok(json!({"nextSeq":w.store.next_seq()}))
        }
        "scan" => {
            let p = r.params.unwrap_or(Value::Null);
            let from = p.get("fromSeq").and_then(Value::as_u64).unwrap_or(0);
            let limit = p
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(1000)
                .min(10000) as usize;
            let records = if let Some(session) = p.get("sessionId").and_then(Value::as_str) {
                w.store.scan_limited(&parse_id(session)?, from, limit + 1)
            } else {
                w.store.scan_all_limited(from, limit + 1)
            }
            .map_err(|e| e.to_string())?;
            let more = records.len() > limit;
            let values=records.into_iter().take(limit).map(|r|json!({"seq":r.seq,"sessionId":r.session_id.to_hex(),"kind":r.kind,"tsMs":r.ts_ms,"body":r.body})).collect::<Vec<_>>();
            Ok(
                json!({"nextSeq":w.store.next_seq(),"nextFromSeq":values.last().and_then(|v|v["seq"].as_u64()).map(|v|v+1).unwrap_or(from),"hasMore":more,"records":values}),
            )
        }
        _ => Err("unsupported RPC method".into()),
    })
}
async fn stop(State(s): State<AppState>, h: HeaderMap) -> Response {
    if let Err(r) = authorized(&h, &s, true) {
        return r;
    }
    if let Some(tx) = s.shutdown.lock().ok().and_then(|mut v| v.take()) {
        let _ = tx.send(());
    }
    Json(json!({"ok":true})).into_response()
}
async fn browser_session(State(s): State<AppState>, h: HeaderMap) -> Response {
    if let Err(r) = authorized(&h, &s, true) {
        return r;
    }
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let code = hex::encode(bytes);
    if let Ok(mut codes) = s.browser_codes.lock() {
        let now = now_ms();
        codes.retain(|_, expires_at| *expires_at > now);
        codes.insert(code.clone(), now.saturating_add(BROWSER_CODE_TTL_MS));
    }
    Json(json!({"url":format!("{}/auth/browser?code={}",s.writer.lock().ok().map(|w|read_descriptor_url(&w.paths.descriptor)).unwrap_or_default(),code)})).into_response()
}
#[derive(Deserialize)]
struct BrowserQuery {
    code: String,
}
async fn browser_auth(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(q): Query<BrowserQuery>,
) -> Response {
    if let Err(response) = validate_local_request(&h, &s) {
        return response;
    }
    let now = now_ms();
    let valid = s
        .browser_codes
        .lock()
        .ok()
        .is_some_and(|mut codes| consume_browser_code(&mut codes, &q.code, now));
    if !valid {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "permission_denied",
            "browser code is invalid or already used",
        );
    }
    let mut response = (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, "/universal-session-log/console")],
        "",
    )
        .into_response();
    if let Ok(value) = format!(
        "sesdb_read={}; HttpOnly; SameSite=Strict; Path=/",
        s.read_token
    )
    .parse()
    {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}
async fn console() -> Html<&'static str> {
    Html(include_str!("../../../packages/sesdb/console/index.html"))
}
async fn console_mode() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        "window.__SESDB_CONSOLE__={mode:'daemon',baseUrl:''};",
    )
        .into_response()
}
async fn static_asset(State(s): State<AppState>, h: HeaderMap, uri: Uri) -> Response {
    if let Err(response) = authorized(&h, &s, false) {
        return response;
    }
    let requested = uri
        .path()
        .strip_prefix("/universal-session-log/")
        .unwrap_or("");
    if requested
        .split('/')
        .any(|part| part == ".." || part.contains('\\'))
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_parameter",
            "invalid asset path",
        );
    }
    let relative = if requested == "console" || requested == "console/" {
        "console.html"
    } else {
        requested
    };
    let Some(root) = console_export_root() else {
        if relative == "console.html" {
            return console().await.into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = root.join(relative);
    if !path.starts_with(&root) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_parameter",
            "invalid asset path",
        );
    }
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mime = match path.extension().and_then(|v| v.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "application/javascript",
                Some("css") => "text/css",
                Some("json") => "application/json",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
fn console_export_root() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SESDB_CONSOLE_DIR").map(PathBuf::from) {
        if path.join("console.html").exists() {
            return Some(path);
        }
    }
    let executable = std::env::current_exe().ok()?;
    let packaged = executable
        .parent()?
        .parent()?
        .parent()?
        .join("console/site");
    if packaged.join("console.html").exists() {
        return Some(packaged);
    }
    let repository = executable.parent()?.parent()?.parent()?.join("site/out");
    if repository.join("console.html").exists() {
        return Some(repository);
    }
    None
}

fn parse_id(value: &str) -> Result<SessionId, String> {
    let bytes = hex::decode(value).map_err(|e| e.to_string())?;
    let array: [u8; 32] = bytes.try_into().map_err(|_| "invalid session id")?;
    Ok(SessionId(array))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn read_descriptor_url(path: &Path) -> String {
    std::fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice::<Descriptor>(&v).ok())
        .map(|v| v.base_url)
        .unwrap_or_default()
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageCursor {
    route: String,
    binding: String,
    generation: u64,
    as_of_seq: u64,
    offset: usize,
}
fn cursor_offset(
    cursor: Option<&str>,
    secret: &str,
    route: &str,
    binding: &str,
    writer: &Writer,
) -> Result<usize, String> {
    let Some(cursor) = cursor else { return Ok(0) };
    let (payload, signature) = cursor.rsplit_once('.').ok_or("invalid cursor")?;
    let expected = hex::encode(Sha256::digest(format!("{secret}.{payload}")));
    if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
        return Err("invalid cursor signature".into());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "invalid cursor")?;
    let value: PageCursor = serde_json::from_slice(&bytes).map_err(|_| "invalid cursor")?;
    if value.route != route
        || value.binding != binding
        || value.generation
            != writer
                .sidecar
                .status(writer.store.next_seq(), writer.degraded)
                .generation
        || value.as_of_seq != writer.store.next_seq()
    {
        return Err("cursor does not match this query snapshot".into());
    }
    Ok(value.offset)
}
fn with_next_cursor(
    mut value: Value,
    secret: &str,
    route: &str,
    binding: &str,
    writer: &Writer,
    offset: usize,
    limit: usize,
) -> Value {
    if value.get("items").and_then(Value::as_array).map(Vec::len) == Some(limit) {
        let status = writer
            .sidecar
            .status(writer.store.next_seq(), writer.degraded);
        let cursor = PageCursor {
            route: route.into(),
            binding: binding.into(),
            generation: status.generation,
            as_of_seq: writer.store.next_seq(),
            offset: offset + limit,
        };
        if let Ok(bytes) = serde_json::to_vec(&cursor) {
            let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            let signature = hex::encode(Sha256::digest(format!("{secret}.{payload}")));
            value["nextCursor"] = json!(format!("{payload}.{signature}"));
        }
    }
    value
}
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
fn consume_browser_code(codes: &mut BTreeMap<String, u64>, code: &str, now: u64) -> bool {
    codes
        .remove(code)
        .is_some_and(|expires_at| expires_at > now)
}
fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        set_dir_private(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let file = options.open(&temporary)?;
        serde_json::to_writer_pretty(&file, value)?;
        file.sync_all()?;
    }
    set_file_private(&temporary)?;
    std::fs::rename(temporary, path)?;
    set_file_private(path)
}
#[cfg(unix)]
fn set_file_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}
#[cfg(not(unix))]
fn set_file_private(_: &Path) -> io::Result<()> {
    Ok(())
}
#[cfg(unix)]
fn set_dir_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}
#[cfg(not(unix))]
fn set_dir_private(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{consume_browser_code, ProviderKind, Writer};
    use crate::Paths;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn browser_codes_are_single_use_and_expire() {
        let mut codes = BTreeMap::from([("fresh".to_owned(), 101), ("expired".to_owned(), 99)]);
        assert!(consume_browser_code(&mut codes, "fresh", 100));
        assert!(!consume_browser_code(&mut codes, "fresh", 100));
        assert!(!consume_browser_code(&mut codes, "expired", 100));
        assert!(codes.is_empty());
    }

    #[test]
    fn inventory_audit_recovers_lost_hints_and_applies_delete_grace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sesdb-watcher-audit-{}-{nonce}",
            std::process::id()
        ));
        let provider = root.join("provider");
        std::fs::create_dir_all(&provider).unwrap();
        let first = provider.join("first.jsonl");
        let second = provider.join("second.jsonl");
        std::fs::write(&first, b"{\"type\":\"user\",\"sessionId\":\"audit-one\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"first audit needle\"}}\n").unwrap();
        let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
        writer.enable(ProviderKind::Claude, Some(provider)).unwrap();

        assert_eq!(
            writer.watch_tick_at(Vec::new(), 100_000).unwrap()["events"],
            1
        );
        std::fs::write(&second, b"{\"type\":\"user\",\"sessionId\":\"audit-two\",\"uuid\":\"u2\",\"timestamp\":1001,\"message\":{\"content\":\"lost hint needle\"}}\n").unwrap();
        assert_eq!(
            writer.watch_tick_at(Vec::new(), 110_000).unwrap()["events"],
            0
        );
        assert!(writer
            .sidecar
            .search("lost hint needle", false, 10, 0)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            writer.watch_tick_at(Vec::new(), 130_001).unwrap()["events"],
            1
        );

        std::fs::remove_file(&first).unwrap();
        writer.watch_tick_at(Vec::new(), 160_002).unwrap();
        assert_eq!(
            writer
                .sidecar
                .search("first audit needle", false, 10, 0)
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        writer.watch_tick_at(Vec::new(), 190_003).unwrap();
        assert!(writer
            .sidecar
            .search("first audit needle", false, 10, 0)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            writer.sidecar.sessions(10, 0).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(writer);
        std::fs::remove_dir_all(root).unwrap();
    }
}
