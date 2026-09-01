use sesdb_engine::daemon::Writer;
use sesdb_engine::model::{NativeEvidence, KIND_EVIDENCE};
use sesdb_engine::provider::ProviderKind;
use sesdb_engine::Paths;
use sha2::Digest;
use std::fs::FileTimes;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture(tag: &str) -> (PathBuf, PathBuf) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("sesdb-daemon-{tag}-{}-{nonce}", std::process::id()));
    let provider = root.join("provider");
    std::fs::create_dir_all(&provider).unwrap();
    (root, provider)
}

#[test]
fn claude_incremental_reconcile_is_idempotent_and_rebuildable() {
    let (root, provider) = fixture("claude");
    let source = provider.join("session.jsonl");
    std::fs::write(&source, concat!(
        "{\"type\":\"user\",\"sessionId\":\"native-1\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"needle request\"}}\n",
        "{\"type\":\"assistant\",\"sessionId\":\"native-1\",\"uuid\":\"a1\",\"timestamp\":1001,\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"needle answer\"}]}}\n",
    )).unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer
        .enable(ProviderKind::Claude, Some(provider.clone()))
        .unwrap();
    assert_eq!(
        writer.reconcile(Some(ProviderKind::Claude)).unwrap()["events"],
        2
    );
    let through = writer.store.next_seq();
    assert_eq!(
        writer.reconcile(Some(ProviderKind::Claude)).unwrap()["events"],
        0
    );
    assert_eq!(writer.store.next_seq(), through);
    let search = writer
        .sidecar
        .search("needle answer", false, 10, 0)
        .unwrap();
    assert_eq!(search["items"].as_array().unwrap().len(), 1);

    let evidence = writer
        .store
        .scan_all(0)
        .unwrap()
        .into_iter()
        .find(|record| record.kind == KIND_EVIDENCE)
        .unwrap();
    let body: NativeEvidence = serde_json::from_slice(&evidence.body).unwrap();
    assert_eq!(hex::encode(sha2::Sha256::digest(&body.raw)), body.sha256);

    let generation = writer
        .sidecar
        .status(writer.store.next_seq(), false)
        .generation;
    writer.rebuild().unwrap();
    assert!(
        writer
            .sidecar
            .status(writer.store.next_seq(), false)
            .generation
            > generation
    );
    assert_eq!(
        writer
            .sidecar
            .search("needle answer", false, 10, 0)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rewrite_supersedes_the_previous_source_generation() {
    let (root, provider) = fixture("rewrite");
    let source = provider.join("session.jsonl");
    let line = |text: &str| {
        format!("{{\"type\":\"user\",\"sessionId\":\"native-1\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{{\"content\":\"{text}\"}}}}\n")
    };
    std::fs::write(&source, line("firstxx")).unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer
        .enable(ProviderKind::Claude, Some(provider.clone()))
        .unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    std::fs::write(&source, line("secondx")).unwrap(); // same-size rewrite
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    assert_eq!(
        writer.sidecar.search("firstxx", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        writer.sidecar.search("firstxx", true, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        writer.sidecar.search("secondx", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn discovery_is_metadata_only_and_providers_default_to_disabled() {
    let (root, provider) = fixture("opt-in");
    std::fs::write(provider.join("broken.jsonl"), b"not json\n").unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer.config.providers.get_mut("claude").unwrap().roots = vec![provider];
    let discovered = writer.discover(Some(ProviderKind::Claude)).unwrap();
    assert_eq!(discovered["contentRead"], false);
    assert_eq!(discovered["sources"].as_array().unwrap().len(), 1);
    assert_eq!(
        writer.reconcile(Some(ProviderKind::Claude)).unwrap()["events"],
        0
    );
    assert_eq!(writer.store.next_seq(), 0);
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cjk_search_selects_trigram_or_bounded_fallback_explicitly() {
    let (root, provider) = fixture("cjk");
    std::fs::write(
        provider.join("session.jsonl"),
        "{\"type\":\"user\",\"sessionId\":\"native-cjk\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"你好世界 mixed text\"}}\n",
    )
    .unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();

    let short = writer.sidecar.search("你好", false, 10, 0).unwrap();
    assert_eq!(short["matchMode"], "boundedSubstring");
    assert_eq!(short["partial"], false);
    assert_eq!(short["items"].as_array().unwrap().len(), 1);

    let trigram = writer.sidecar.search("你好世", false, 10, 0).unwrap();
    assert_eq!(trigram["matchMode"], "trigram");
    assert_eq!(trigram["partial"], false);
    assert_eq!(trigram["items"].as_array().unwrap().len(), 1);
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn visibility_retraction_hides_empty_sessions_but_keeps_history() {
    let (root, provider) = fixture("visibility");
    let source = provider.join("session.jsonl");
    std::fs::write(
        &source,
        "{\"type\":\"user\",\"sessionId\":\"native-hidden\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"hide me\"}}\n",
    )
    .unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    writer
        .retract_missing(ProviderKind::Claude, &source.to_string_lossy())
        .unwrap();

    assert!(writer.sidecar.sessions(10, 0).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        writer.sidecar.search("hide me", true, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        writer.sidecar.search("hide me", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn l1_replay_prevents_duplicates_when_invalid_sidecar_is_rebuilt() {
    let (root, provider) = fixture("l1-replay");
    let source = provider.join("session.jsonl");
    std::fs::write(
        &source,
        "{\"type\":\"user\",\"sessionId\":\"native-replay\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"replay needle\"}}\n",
    )
    .unwrap();
    let paths = Paths::under(root.join("home"));
    let mut writer = Writer::open(paths.clone()).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    let through = writer.store.next_seq();
    drop(writer);
    rusqlite::Connection::open(&paths.sqlite)
        .unwrap()
        .execute("DROP TABLE events", [])
        .unwrap();

    let mut reopened = Writer::open(paths).unwrap();
    assert_eq!(
        reopened.reconcile(Some(ProviderKind::Claude)).unwrap()["events"],
        0
    );
    assert_eq!(reopened.store.next_seq(), through);
    assert_eq!(
        reopened
            .sidecar
            .search("replay needle", false, 10, 0)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn sidecar_transaction_failure_stops_collection_until_automatic_repair() {
    let (root, provider) = fixture("sidecar-failure");
    let source = provider.join("session.jsonl");
    std::fs::write(
        &source,
        "{\"type\":\"user\",\"sessionId\":\"native-failure\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"before\"}}\n",
    )
    .unwrap();
    let paths = Paths::under(root.join("home"));
    let mut writer = Writer::open(paths.clone()).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();
    writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    rusqlite::Connection::open(&paths.sqlite)
        .unwrap()
        .execute("DROP TABLE events", [])
        .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"{\"type\":\"user\",\"sessionId\":\"native-failure\",\"uuid\":\"u2\",\"timestamp\":1001,\"message\":{\"content\":\"after repair\"}}\n")
        .unwrap();

    let failed = writer.reconcile(Some(ProviderKind::Claude));
    assert!(
        failed.is_ok(),
        "per-source errors are reported in the response"
    );
    assert!(writer.degraded);
    let committed = writer.store.next_seq();
    let repaired = writer.reconcile(Some(ProviderKind::Claude)).unwrap();
    assert_eq!(repaired["events"], 0);
    assert!(!writer.degraded);
    assert_eq!(writer.store.next_seq(), committed);
    assert_eq!(
        writer.sidecar.search("after repair", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn layered_watcher_handles_long_open_partial_and_same_size_rewrite() {
    let (root, provider) = fixture("watcher");
    let source = provider.join("session.jsonl");
    let first = "{\"type\":\"user\",\"sessionId\":\"native-watch\",\"uuid\":\"u1\",\"timestamp\":1000,\"message\":{\"content\":\"firstxx\"}}\n";
    let second = "{\"type\":\"user\",\"sessionId\":\"native-watch\",\"uuid\":\"u2\",\"timestamp\":1001,\"message\":{\"content\":\"secondx\"}}";
    std::fs::write(&source, first).unwrap();
    let mut writer = Writer::open(Paths::under(root.join("home"))).unwrap();
    writer.enable(ProviderKind::Claude, Some(provider)).unwrap();

    // No notification hint: the inventory audit still discovers the file.
    assert_eq!(writer.watch_tick(Vec::new()).unwrap()["events"], 1);
    let mut open = std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap();
    open.write_all(second.as_bytes()).unwrap();
    open.flush().unwrap();
    let through = writer.store.next_seq();
    assert_eq!(writer.watch_tick(Vec::new()).unwrap()["events"], 0);
    assert_eq!(writer.store.next_seq(), through);
    open.write_all(b"\n").unwrap();
    open.flush().unwrap();
    assert_eq!(writer.watch_tick(Vec::new()).unwrap()["events"], 1);
    drop(open);

    let original_mtime = std::fs::metadata(&source).unwrap().modified().unwrap();
    let rewritten = format!("{}{}\n", first.replace("firstxx", "changed"), second);
    assert_eq!(rewritten.len(), first.len() + second.len() + 1);
    std::fs::write(&source, rewritten).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(original_mtime))
        .unwrap();
    assert_eq!(writer.watch_tick(Vec::new()).unwrap()["events"], 2);
    assert!(
        writer.sidecar.search("firstxx", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        writer.sidecar.search("changed", false, 10, 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(writer);
    std::fs::remove_dir_all(root).unwrap();
}
