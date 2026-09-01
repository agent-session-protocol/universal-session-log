use serde_json::json;
use sesdb_engine::daemon::Writer;
use sesdb_engine::model::{
    CanonicalEventBody, NativeEvidence, SourceCheckpoint, KIND_CANONICAL_EVENT, KIND_EVIDENCE,
    KIND_SOURCE_CHECKPOINT,
};
use sesdb_engine::provider::{
    adapter, canonical_id, complete_offset, event_digest, fingerprints, session_id, ProviderKind,
};
use sesdb_engine::{canonical_session_id, Paths};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use usl_core::{Record, SessionId, Store, StoreOpts};

fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "sesdb-killpoint-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let provider = root.join("provider");
    std::fs::create_dir_all(&provider).unwrap();
    let source = provider.join("session.jsonl");
    std::fs::write(
        &source,
        b"{\"type\":\"user\",\"sessionId\":\"killpoint-native\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"killpoint needle\"}}\n",
    )
    .unwrap();
    (root, provider, source)
}

fn parse_id(value: &str) -> SessionId {
    SessionId(hex::decode(value).unwrap().try_into().unwrap())
}

fn capture_records(source: &Path) -> Vec<Record> {
    let bytes = std::fs::read(source).unwrap();
    let completed = complete_offset(&bytes);
    let native = adapter(ProviderKind::Claude)
        .parse_snapshot(source, &bytes[..completed], 0)
        .unwrap()
        .remove(0);
    let path = source.to_string_lossy().into_owned();
    let generation = 1;
    let id = canonical_id(ProviderKind::Claude, &native, generation);
    let sid = session_id(ProviderKind::Claude, &native.native_session_id);
    let digest = event_digest(&native);
    let evidence = NativeEvidence {
        version: 1,
        provider: "claude".into(),
        source_path: path.clone(),
        source_generation: generation,
        byte_start: native.byte_start,
        byte_end: native.byte_end,
        sha256: digest.clone(),
        raw: native.raw,
    };
    let timestamp = "1970-01-01T00:00:01.000Z";
    let pointer = json!({"sessionId":sid,"eventId":id,"sourcePath":path,"sourceDigest":digest,"byteStart":native.byte_start,"byteEnd":native.byte_end,"parserVersion":"claude@1"});
    let canonical_event = json!({"schemaVersion":"1.0","eventId":id,"sessionId":sid,"type":native.event_type,"timestamp":timestamp,"timestampMs":native.timestamp_ms,"payload":native.event});
    let canonical = CanonicalEventBody {
        version: 1,
        provider: "claude".into(),
        native_session_id: native.native_session_id,
        source_path: path.clone(),
        source_generation: generation,
        event_id: id,
        native_identity: native.native_identity,
        entity_revision: native.entity_revision,
        event: canonical_event,
        evidence: Some(pointer),
        evidence_seqs: vec![0],
    };
    let checkpoint = SourceCheckpoint {
        version: 1,
        provider: "claude".into(),
        source_path: path.clone(),
        generation,
        committed_offset: completed as u64,
        snapshot_length: bytes.len() as u64,
        chunks: fingerprints(&bytes),
    };
    vec![
        Record::new(
            parse_id(&sid),
            KIND_EVIDENCE,
            native.timestamp_ms,
            serde_json::to_vec(&evidence).unwrap(),
        ),
        Record::new(
            parse_id(&sid),
            KIND_CANONICAL_EVENT,
            native.timestamp_ms,
            serde_json::to_vec(&canonical).unwrap(),
        ),
        Record::new(
            parse_id(&canonical_session_id("claude", &path)),
            KIND_SOURCE_CHECKPOINT,
            1000,
            serde_json::to_vec(&checkpoint).unwrap(),
        ),
    ]
}

fn recover_prefix(prefix: usize, flush: bool) -> (usize, Vec<u8>, usize) {
    let (root, provider, source) = fixture(&format!("prefix-{prefix}-{flush}"));
    let paths = Paths::under(root.join("home"));
    let mut initial = Writer::open(paths.clone()).unwrap();
    initial
        .enable(ProviderKind::Claude, Some(provider))
        .unwrap();
    drop(initial);

    let records = capture_records(&source);
    let mut store = Store::open(&paths.log, StoreOpts::default()).unwrap();
    store.append_batch(&records[..prefix]).unwrap();
    if flush {
        store.flush().unwrap();
    }
    drop(store); // process death: the header may be stale when flush=false

    let mut reopened = Writer::open(paths).unwrap();
    let accepted = reopened.reconcile(Some(ProviderKind::Claude)).unwrap()["events"]
        .as_u64()
        .unwrap() as usize;
    let kinds = reopened
        .store
        .scan_all(0)
        .unwrap()
        .into_iter()
        .map(|record| record.kind)
        .collect::<Vec<_>>();
    let hits = reopened
        .sidecar
        .search("killpoint needle", false, 10, 0)
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .len();
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
    (accepted, kinds, hits)
}

#[test]
fn kill_after_evidence_allows_orphan_and_recovers_one_canonical_event() {
    let (accepted, kinds, hits) = recover_prefix(1, true);
    assert_eq!(accepted, 1);
    assert_eq!(
        kinds.iter().filter(|kind| **kind == KIND_EVIDENCE).count(),
        2
    );
    assert_eq!(
        kinds
            .iter()
            .filter(|kind| **kind == KIND_CANONICAL_EVENT)
            .count(),
        1
    );
    assert_eq!(hits, 1);
}

#[test]
fn kill_after_canonical_only_adds_the_missing_checkpoint() {
    let (accepted, kinds, hits) = recover_prefix(2, true);
    assert_eq!(accepted, 0);
    assert_eq!(
        kinds,
        vec![KIND_EVIDENCE, KIND_CANONICAL_EVENT, KIND_SOURCE_CHECKPOINT]
    );
    assert_eq!(hits, 1);
}

#[test]
fn kill_after_checkpoint_is_already_idempotent() {
    let (accepted, kinds, hits) = recover_prefix(3, true);
    assert_eq!(accepted, 0);
    assert_eq!(
        kinds,
        vec![KIND_EVIDENCE, KIND_CANONICAL_EVENT, KIND_SOURCE_CHECKPOINT]
    );
    assert_eq!(hits, 1);
}

#[test]
fn kill_before_flush_recovers_from_frames_instead_of_the_stale_header() {
    let (accepted, kinds, hits) = recover_prefix(3, false);
    assert_eq!(accepted, 0);
    assert_eq!(
        kinds,
        vec![KIND_EVIDENCE, KIND_CANONICAL_EVENT, KIND_SOURCE_CHECKPOINT]
    );
    assert_eq!(hits, 1);
}

#[test]
fn kill_during_generation_switch_rebuilds_from_l1_without_duplicates() {
    let (root, provider, source) = fixture("generation-switch");
    let paths = Paths::under(root.join("home"));
    let mut writer = Writer::open(paths.clone()).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    let through = writer.store.next_seq();
    let generation = writer.sidecar.status(through, false).generation;
    drop(writer);

    let interrupted_backup = paths.sqlite.with_extension("sqlite.previous");
    std::fs::rename(&paths.sqlite, &interrupted_backup).unwrap();
    std::fs::write(
        paths
            .sqlite
            .with_extension(format!("sqlite.rebuild-{}", std::process::id())),
        b"interrupted temporary generation",
    )
    .unwrap();
    let mut reopened = Writer::open(paths).unwrap();
    assert!(
        reopened
            .sidecar
            .status(reopened.store.next_seq(), false)
            .generation
            > generation
    );
    assert_eq!(
        reopened.reconcile(Some(ProviderKind::Claude)).unwrap()["events"],
        0
    );
    assert_eq!(reopened.store.next_seq(), through);
    assert_eq!(
        reopened
            .sidecar
            .search("killpoint needle", false, 10, 0)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(source.exists());
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
