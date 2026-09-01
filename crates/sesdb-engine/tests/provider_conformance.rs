use sesdb_engine::provider::{adapter, ProviderKind, WatchTarget};
use std::path::{Path, PathBuf};

fn fixture(provider: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/providers")
        .join(provider)
}

#[test]
fn all_five_providers_expose_typed_health_and_metadata_only_discovery() {
    for kind in ProviderKind::ALL {
        let provider = adapter(kind);
        let health = provider.health();
        assert_eq!(health.status, "ready");
        assert_eq!(health.watch_mode, "typed");

        let sources = provider.discover(&[fixture(kind.name())]).unwrap();
        assert!(
            !sources.is_empty(),
            "{} fixture was not discovered",
            kind.name()
        );
        assert!(sources.iter().all(|source| {
            !source.artifacts.is_empty()
                && source.artifacts.iter().all(|artifact| artifact.size > 0)
                && source
                    .watch_targets
                    .iter()
                    .all(|target| matches!(target, WatchTarget::ExactFile { .. }))
        }));
    }
}

#[test]
fn pi_uses_the_shared_typescript_fixture_as_its_semantic_oracle() {
    let provider = adapter(ProviderKind::Pi);
    let source = provider.discover(&[fixture("pi")]).unwrap().remove(0);
    let events = provider
        .parse(&provider.snapshot(&source).unwrap(), 0)
        .unwrap();

    // packages/usl-convert/test/fixtures.ts reads this exact file. These stable
    // identities and classifications are the cross-language differential oracle.
    assert_eq!(events.len(), 10);
    assert_eq!(
        events[0].native_identity,
        "019fff74-b539-7a7d-90c9-ad8895912e04"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "message.created")
            .count(),
        5
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "tool.completed")
            .count(),
        1
    );
    assert!(events.iter().all(|event| event.evidence_spans.len() == 1));
}

#[test]
fn kimi_groups_state_and_agent_wires_with_parentage() {
    let provider = adapter(ProviderKind::Kimi);
    let sources = provider.discover(&[fixture("kimi")]).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].artifacts.len(), 3);

    let events = provider
        .parse(&provider.snapshot(&sources[0]).unwrap(), 0)
        .unwrap();
    assert!(events
        .iter()
        .any(|event| event.event_type == "session.metadata"));
    assert!(events
        .iter()
        .any(|event| event.event_type == "tool.completed"));
    assert!(events
        .iter()
        .any(|event| event.event_type == "session.summary"));
    assert!(events.iter().any(|event| {
        event.event.get("agentId").and_then(|value| value.as_str()) == Some("agent-0")
            && event
                .event
                .get("parentAgentId")
                .and_then(|value| value.as_str())
                == Some("main")
    }));
    assert!(events.iter().all(|event| !event.evidence_spans.is_empty()));
}

#[test]
fn deepseek_concatenated_zstd_matches_raw_and_links_tools() {
    let provider = adapter(ProviderKind::Deepseek);
    let sources = provider.discover(&[fixture("deepseek")]).unwrap();
    let raw = sources
        .iter()
        .find(|source| source.path.ends_with("session.jsonl"))
        .unwrap();
    let compressed = sources
        .iter()
        .find(|source| source.path.ends_with("session.jsonl.zstd"))
        .unwrap();
    let raw_events = provider.parse(&provider.snapshot(raw).unwrap(), 0).unwrap();
    let compressed_events = provider
        .parse(&provider.snapshot(compressed).unwrap(), 0)
        .unwrap();

    let semantics = |events: &[sesdb_engine::provider::ParsedNativeEvent]| {
        events
            .iter()
            .map(|event| (event.native_identity.clone(), event.event_type.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(semantics(&raw_events), semantics(&compressed_events));
    assert!(raw_events
        .iter()
        .any(|event| event.event_type == "message.partial"));
    assert!(raw_events.iter().any(|event| {
        event.event_type == "tool.completed"
            && event.event.get("callId").and_then(|value| value.as_str()) == Some("call-1")
    }));
    assert!(raw_events
        .iter()
        .all(|event| !event.evidence_spans.is_empty()));
}
