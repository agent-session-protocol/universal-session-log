use sesdb_engine::daemon::Writer;
use sesdb_engine::index::QueryFilters;
use sesdb_engine::model::{MemoryAction, KIND_EVIDENCE};
use sesdb_engine::provider::ProviderKind;
use sesdb_engine::Paths;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn corpus(provider: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/providers")
        .join(provider)
}

#[test]
fn memory_requires_evidence_and_explicit_revisioned_approval() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sesdb-memory-journey-{nonce}"));
    let mut writer = Writer::open(Paths::under(root.join(".sesdb"))).unwrap();
    writer.enable(ProviderKind::Pi, Some(corpus("pi"))).unwrap();
    writer.reconcile(Some(ProviderKind::Pi)).unwrap();
    let evidence_seq = writer
        .store
        .scan_all(0)
        .unwrap()
        .into_iter()
        .find(|record| record.kind == KIND_EVIDENCE)
        .unwrap()
        .seq;

    let candidate = writer
        .propose_memory(
            "Always run fixture verification".into(),
            serde_json::json!({"project":"fixture"}),
            vec![evidence_seq],
        )
        .unwrap();
    assert_eq!(candidate["status"], "candidate");
    assert!(writer.sidecar.memories("approved", 100).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(writer
        .sidecar
        .search("Always run fixture verification", false, 10, 0)
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());

    let id = candidate["id"].as_str().unwrap();
    assert!(writer.decide_memory(id, 99, MemoryAction::Approve).is_err());
    let approved = writer.decide_memory(id, 1, MemoryAction::Approve).unwrap();
    assert_eq!(approved["revision"], 2);
    assert_eq!(
        writer.sidecar.memories("approved", 100).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    writer.rebuild().unwrap();
    let revoked = writer.decide_memory(id, 2, MemoryAction::Revoke).unwrap();
    assert_eq!(revoked["status"], "revoked");
    assert!(writer.sidecar.memories("approved", 100).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolated_home_indexes_and_queries_all_five_providers() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("sesdb-i0-journey-{nonce}"));
    let mut writer = Writer::open(Paths::under(root.join(".sesdb"))).unwrap();

    for provider in ProviderKind::ALL {
        writer
            .enable(provider, Some(corpus(provider.name())))
            .unwrap();
        let result = writer.reconcile(Some(provider)).unwrap();
        assert!(
            result["events"].as_u64().unwrap_or(0) > 0,
            "{} produced no events: {result}",
            provider.name()
        );
    }

    let sessions = writer.sidecar.sessions(100, 0).unwrap();
    assert!(sessions["items"].as_array().unwrap().len() >= 5);
    for needle in ["subagent observation", "answer two", "fixture summary"] {
        assert!(
            !writer.sidecar.search(needle, false, 10, 0).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty(),
            "missing cross-provider search result for {needle}"
        );
    }

    let kimi_only = QueryFilters {
        provider: Some("kimi".into()),
        ..Default::default()
    };
    assert_eq!(
        writer
            .sidecar
            .sessions_filtered(100, 0, &kimi_only)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        writer
            .sidecar
            .search_filtered("subagent observation", false, 10, 0, &kimi_only)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let kimi_id = writer.sidecar.sessions_filtered(1, 0, &kimi_only).unwrap()["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        writer
            .sidecar
            .events_window(
                &kimi_id,
                false,
                100,
                0,
                Some(1_786_705_203_000),
                Some(1_786_705_205_000)
            )
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );

    writer.rebuild().unwrap();
    assert_eq!(writer.reconcile(None).unwrap()["events"].as_u64(), Some(0));
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}
