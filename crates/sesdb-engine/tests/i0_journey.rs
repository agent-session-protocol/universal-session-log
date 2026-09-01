use sesdb_engine::daemon::Writer;
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

    writer.rebuild().unwrap();
    assert_eq!(writer.reconcile(None).unwrap()["events"].as_u64(), Some(0));
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}
