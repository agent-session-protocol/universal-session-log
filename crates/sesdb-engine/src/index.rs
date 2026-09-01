use crate::model::{
    CanonicalEventBody, MemoryAction, MemoryRecord, NativeEvidence, VisibilityControl,
    KIND_CANONICAL_EVENT, KIND_EVIDENCE, KIND_MEMORY, KIND_VISIBILITY,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use usl_core::{Store, StoredRecord};

const SCHEMA_VERSION: i64 = 5;
const FALLBACK_SCAN_BUDGET: i64 = 10_000;

#[derive(Debug)]
pub struct Sidecar {
    path: PathBuf,
    connection: Connection,
    generation: u64,
    built_through_seq: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub schema_version: i64,
    pub generation: u64,
    pub built_through_seq: u64,
    pub as_of_seq: u64,
    pub degraded: bool,
    pub rebuilding: bool,
    /// SQLite row changes observed by this sidecar connection. This is a
    /// portable write-amplification signal, not a count of filesystem writes.
    pub sqlite_write_changes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct QueryFilters {
    pub provider: Option<String>,
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
}

impl Sidecar {
    pub fn open_or_rebuild(path: impl AsRef<Path>, store: &Store) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.exists() {
            if let Ok(mut sidecar) = Self::open_existing(&path) {
                if sidecar.built_through_seq <= store.next_seq() {
                    if sidecar.catch_up(store).is_ok() {
                        return Ok(sidecar);
                    }
                }
            }
        }
        Self::rebuild(path, store)
    }

    fn open_existing(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        let values: Option<(i64, u64, u64)> = connection
            .query_row(
                "SELECT schema_version, generation, built_through_seq FROM meta WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((schema, generation, built)) = values else {
            return Err("missing sidecar metadata".into());
        };
        if schema != SCHEMA_VERSION {
            return Err("sidecar schema mismatch".into());
        }
        let integrity: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err(format!("sidecar integrity check failed: {integrity}"));
        }
        for required in [
            "meta",
            "sources",
            "sessions",
            "evidence",
            "events",
            "event_evidence",
            "memories",
            "events_fts",
            "events_fts_trigram",
        ] {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                    [required],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !present {
                return Err(format!("sidecar schema is missing {required}"));
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
            connection,
            generation,
            built_through_seq: built,
        })
    }

    pub fn rebuild(path: impl AsRef<Path>, store: &Store) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let previous = Self::open_existing(&path)
            .ok()
            .map(|s| s.generation)
            .unwrap_or(0);
        let clock_generation = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let generation = (previous + 1).max(clock_generation);
        let temporary = path.with_extension(format!("sqlite.rebuild-{}", std::process::id()));
        let _ = std::fs::remove_file(&temporary);
        let mut connection = Connection::open(&temporary).map_err(|e| e.to_string())?;
        create_schema(&connection, generation).map_err(|e| e.to_string())?;
        {
            let transaction = connection.transaction().map_err(|e| e.to_string())?;
            for record in store.scan_all(0).map_err(|e| e.to_string())? {
                project_record(&transaction, &record).map_err(|e| e.to_string())?;
            }
            transaction
                .execute(
                    "UPDATE meta SET built_through_seq=?1 WHERE singleton=1",
                    [store.next_seq()],
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;")
            .map_err(|e| e.to_string())?;
        drop(connection);
        let backup = path.with_extension("sqlite.previous");
        let _ = std::fs::remove_file(&backup);
        if path.exists() {
            std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = std::fs::rename(&temporary, &path) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &path);
            }
            return Err(error.to_string());
        }
        let _ = std::fs::remove_file(backup);
        Self::open_existing(&path)
    }

    pub fn project(&mut self, records: &[StoredRecord]) -> Result<(), String> {
        if let Some(first) = records.first() {
            if first.seq != self.built_through_seq {
                return Err(format!(
                    "sidecar projection gap: built through {}, next record is {}",
                    self.built_through_seq, first.seq
                ));
            }
        }
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        for record in records {
            project_record(&transaction, record).map_err(|e| e.to_string())?;
        }
        let built = records
            .last()
            .map(|r| r.seq + 1)
            .unwrap_or(self.built_through_seq);
        transaction
            .execute(
                "UPDATE meta SET built_through_seq=?1 WHERE singleton=1",
                [built],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        self.built_through_seq = built;
        Ok(())
    }

    pub fn catch_up(&mut self, store: &Store) -> Result<(), String> {
        if self.built_through_seq > store.next_seq() {
            return Err(format!(
                "sidecar is ahead of L1: {} > {}",
                self.built_through_seq,
                store.next_seq()
            ));
        }
        if self.built_through_seq == store.next_seq() {
            return Ok(());
        }
        let records = store
            .scan_all(self.built_through_seq)
            .map_err(|e| e.to_string())?;
        self.project(&records)
    }

    pub fn repair_live(&mut self, store: &Store) -> Result<(), String> {
        if self.catch_up(store).is_ok() {
            return Ok(());
        }
        self.rebuild_live(store)
    }

    pub fn rebuild_live(&mut self, store: &Store) -> Result<(), String> {
        let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old = std::mem::replace(&mut self.connection, placeholder);
        drop(old);
        let replacement = Self::rebuild(self.path.clone(), store)?;
        *self = replacement;
        Ok(())
    }

    pub fn status(&self, as_of_seq: u64, degraded: bool) -> IndexStatus {
        IndexStatus {
            schema_version: SCHEMA_VERSION,
            generation: self.generation,
            built_through_seq: self.built_through_seq,
            as_of_seq,
            degraded,
            rebuilding: false,
            sqlite_write_changes: self.connection.total_changes(),
        }
    }

    pub fn sessions(&self, limit: usize, offset: usize) -> Result<Value, String> {
        self.sessions_filtered(limit, offset, &QueryFilters::default())
    }

    pub fn sessions_filtered(
        &self,
        limit: usize,
        offset: usize,
        filters: &QueryFilters,
    ) -> Result<Value, String> {
        let mut statement = self.connection.prepare(
            "SELECT session_id, native_session_id, provider, project, title, event_count, first_seen_at, last_updated_at FROM sessions WHERE active=1 AND (?1 IS NULL OR provider=?1) AND (?2 IS NULL OR project=?2) AND (?3 IS NULL OR session_id=?3) AND (?4 IS NULL OR last_updated_at>=?4) AND (?5 IS NULL OR first_seen_at<=?5) ORDER BY last_updated_at DESC, session_id LIMIT ?6 OFFSET ?7"
        ).map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![filters.provider,filters.project,filters.session_id,filters.from_ms,filters.to_ms,limit as i64,offset as i64], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "nativeSessionId": row.get::<_, String>(1)?, "provider": row.get::<_, String>(2)?,
            "project": row.get::<_, Option<String>>(3)?, "title": row.get::<_, Option<String>>(4)?, "eventCount": row.get::<_, u64>(5)?,
            "firstSeenAt": row.get::<_, u64>(6)?, "lastUpdatedAt": row.get::<_, u64>(7)?, "status": "synced"
        }))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(
            json!({"items": rows, "generation": self.generation, "builtThroughSeq": self.built_through_seq}),
        )
    }

    pub fn session(&self, id: &str) -> Result<Option<Value>, String> {
        let session = self.connection.query_row(
            "SELECT session_id,native_session_id,provider,project,title,event_count,first_seen_at,last_updated_at FROM sessions WHERE session_id=?1 AND active=1",
            [id], |row| Ok(json!({"id":row.get::<_,String>(0)?,"nativeSessionId":row.get::<_,String>(1)?,"provider":row.get::<_,String>(2)?,"project":row.get::<_,Option<String>>(3)?,"title":row.get::<_,Option<String>>(4)?,"eventCount":row.get::<_,u64>(5)?,"firstSeenAt":row.get::<_,u64>(6)?,"lastUpdatedAt":row.get::<_,u64>(7)?,"status":"synced"}))
        ).optional().map_err(|e| e.to_string())?;
        Ok(session)
    }

    pub fn events(
        &self,
        session_id: &str,
        include_history: bool,
        limit: usize,
        offset: usize,
    ) -> Result<Value, String> {
        self.events_window(session_id, include_history, limit, offset, None, None)
    }

    pub fn events_window(
        &self,
        session_id: &str,
        include_history: bool,
        limit: usize,
        offset: usize,
        from_ms: Option<u64>,
        to_ms: Option<u64>,
    ) -> Result<Value, String> {
        let mut statement = self.connection.prepare("SELECT seq,event_id,event_type,ts_ms,event_json,evidence_seqs,active FROM events WHERE session_id=?1 AND (?2 OR active=1) AND (?3 IS NULL OR ts_ms>=?3) AND (?4 IS NULL OR ts_ms<=?4) ORDER BY seq LIMIT ?5 OFFSET ?6").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(
                params![
                    session_id,
                    include_history,
                    from_ms,
                    to_ms,
                    limit as i64,
                    offset as i64
                ],
                event_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"items":rows,"generation":self.generation,"builtThroughSeq":self.built_through_seq}),
        )
    }

    pub fn search(
        &self,
        text: &str,
        include_history: bool,
        limit: usize,
        offset: usize,
    ) -> Result<Value, String> {
        self.search_filtered(
            text,
            include_history,
            limit,
            offset,
            &QueryFilters::default(),
        )
    }

    pub fn search_filtered(
        &self,
        text: &str,
        include_history: bool,
        limit: usize,
        offset: usize,
        filters: &QueryFilters,
    ) -> Result<Value, String> {
        if text.is_empty() {
            return Err("search text must not be empty".into());
        }
        if text.chars().count() < 3 {
            return self.search_bounded_substring(text, include_history, limit, offset, filters);
        }
        let phrase = format!("\"{}\"", text.replace('"', "\"\""));
        let sql = "SELECT e.seq,e.event_id,e.session_id,e.event_type,e.ts_ms,e.event_json,e.evidence_seqs,bm25(events_fts_trigram) FROM events_fts_trigram JOIN events e ON e.seq=events_fts_trigram.rowid LEFT JOIN sessions s ON s.session_id=e.session_id WHERE events_fts_trigram MATCH ?1 AND (?2 OR e.active=1) AND (?3 IS NULL OR e.provider=?3) AND (?4 IS NULL OR s.project=?4) AND (?5 IS NULL OR e.session_id=?5) AND (?6 IS NULL OR e.ts_ms>=?6) AND (?7 IS NULL OR e.ts_ms<=?7) ORDER BY bm25(events_fts_trigram),e.seq LIMIT ?8 OFFSET ?9";
        let mut statement = self.connection.prepare(sql).map_err(|e| e.to_string())?;
        let hits = statement.query_map(params![phrase,include_history,filters.provider,filters.project,filters.session_id,filters.from_ms,filters.to_ms,limit as i64,offset as i64], |row| {
            let event_json: String = row.get(5)?;
            let evidence: String = row.get(6)?;
            Ok(json!({"seq":row.get::<_,u64>(0)?,"eventId":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"eventType":row.get::<_,String>(3)?,"timestamp":row.get::<_,u64>(4)?,"event":serde_json::from_str::<Value>(&event_json).unwrap_or(Value::Null),"evidenceSeqs":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"score":row.get::<_,f64>(7)?}))
        }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(
            json!({"items":hits,"generation":self.generation,"builtThroughSeq":self.built_through_seq,"partial":false,"matchMode":"trigram"}),
        )
    }

    fn search_bounded_substring(
        &self,
        text: &str,
        include_history: bool,
        limit: usize,
        offset: usize,
        filters: &QueryFilters,
    ) -> Result<Value, String> {
        let sql = "SELECT seq,event_id,session_id,event_type,ts_ms,event_json,evidence_seqs FROM (SELECT e.seq,e.event_id,e.session_id,e.event_type,e.ts_ms,e.event_json,e.evidence_seqs FROM events e LEFT JOIN sessions s ON s.session_id=e.session_id WHERE (?1 OR e.active=1) AND (?2 IS NULL OR e.provider=?2) AND (?3 IS NULL OR s.project=?3) AND (?4 IS NULL OR e.session_id=?4) AND (?5 IS NULL OR e.ts_ms>=?5) AND (?6 IS NULL OR e.ts_ms<=?6) ORDER BY e.seq DESC LIMIT ?7) WHERE instr(lower(event_json),lower(?8))>0 ORDER BY seq LIMIT ?9 OFFSET ?10";
        let mut statement = self.connection.prepare(sql).map_err(|e| e.to_string())?;
        let hits = statement
            .query_map(
                params![
                    include_history,filters.provider,filters.project,filters.session_id,filters.from_ms,filters.to_ms,FALLBACK_SCAN_BUDGET,text,limit as i64,offset as i64
                ],
                |row| {
                    let event_json: String = row.get(5)?;
                    let evidence: String = row.get(6)?;
                    Ok(json!({"seq":row.get::<_,u64>(0)?,"eventId":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"eventType":row.get::<_,String>(3)?,"timestamp":row.get::<_,u64>(4)?,"event":serde_json::from_str::<Value>(&event_json).unwrap_or(Value::Null),"evidenceSeqs":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"score":Value::Null}))
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let eligible: i64 = self
            .connection
            .query_row(
                "SELECT count(*) FROM events e LEFT JOIN sessions s ON s.session_id=e.session_id WHERE (?1 OR e.active=1) AND (?2 IS NULL OR e.provider=?2) AND (?3 IS NULL OR s.project=?3) AND (?4 IS NULL OR e.session_id=?4) AND (?5 IS NULL OR e.ts_ms>=?5) AND (?6 IS NULL OR e.ts_ms<=?6)",
                params![include_history,filters.provider,filters.project,filters.session_id,filters.from_ms,filters.to_ms],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"items":hits,"generation":self.generation,"builtThroughSeq":self.built_through_seq,"partial":eligible>FALLBACK_SCAN_BUDGET,"matchMode":"boundedSubstring","scanBudget":FALLBACK_SCAN_BUDGET}),
        )
    }

    pub fn source(
        &self,
        provider: &str,
        path: &str,
    ) -> Result<Option<(u64, u64, u64, Vec<String>)>, String> {
        self.connection.query_row("SELECT generation, committed_offset, snapshot_length, chunks_json FROM sources WHERE provider=?1 AND source_path=?2", params![provider,path], |row| {
            let chunks: String = row.get(3)?;
            Ok((row.get(0)?,row.get(1)?,row.get(2)?,serde_json::from_str(&chunks).unwrap_or_default()))
        }).optional().map_err(|e| e.to_string())
    }

    pub fn contains_event(&self, event_id: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE event_id=?1)",
                [event_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn source_paths(&self, provider: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT source_path FROM sources WHERE provider=?1")
            .map_err(|e| e.to_string())?;
        let paths = statement
            .query_map([provider], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(paths)
    }

    pub fn memories(&self, status: &str, limit: usize) -> Result<Value, String> {
        let mut statement = self.connection.prepare("SELECT memory_id,content,scope_json,evidence_seqs,revision,status,updated_at_ms FROM memories WHERE status=?1 ORDER BY updated_at_ms DESC,memory_id LIMIT ?2").map_err(|error| error.to_string())?;
        let items = statement.query_map(params![status, limit as i64], |row| {
            let scope: String = row.get(2)?; let evidence: String = row.get(3)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"content":row.get::<_,String>(1)?,"scope":serde_json::from_str::<Value>(&scope).unwrap_or(Value::Null),"evidenceSeqs":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"revision":row.get::<_,u64>(4)?,"status":row.get::<_,String>(5)?,"updatedAt":row.get::<_,u64>(6)?}))
        }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(
            json!({"items":items,"generation":self.generation,"builtThroughSeq":self.built_through_seq}),
        )
    }

    pub fn memory(&self, id: &str) -> Result<Option<Value>, String> {
        self.connection.query_row("SELECT memory_id,content,scope_json,evidence_seqs,revision,status,updated_at_ms FROM memories WHERE memory_id=?1", [id], |row| {
            let scope: String = row.get(2)?; let evidence: String = row.get(3)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"content":row.get::<_,String>(1)?,"scope":serde_json::from_str::<Value>(&scope).unwrap_or(Value::Null),"evidenceSeqs":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"revision":row.get::<_,u64>(4)?,"status":row.get::<_,String>(5)?,"updatedAt":row.get::<_,u64>(6)?}))
        }).optional().map_err(|error| error.to_string())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn create_schema(connection: &Connection, generation: u64) -> rusqlite::Result<()> {
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,generation INTEGER NOT NULL,built_through_seq INTEGER NOT NULL);
      CREATE TABLE sources(provider TEXT NOT NULL,source_path TEXT NOT NULL,generation INTEGER NOT NULL,committed_offset INTEGER NOT NULL,snapshot_length INTEGER NOT NULL,chunks_json TEXT NOT NULL,PRIMARY KEY(provider,source_path));
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY,native_session_id TEXT NOT NULL,provider TEXT NOT NULL,project TEXT,title TEXT,event_count INTEGER NOT NULL,first_seen_at INTEGER NOT NULL,last_updated_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE evidence(seq INTEGER PRIMARY KEY,provider TEXT NOT NULL,source_path TEXT NOT NULL,source_generation INTEGER NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,native_session_id TEXT NOT NULL,native_identity TEXT NOT NULL,provider TEXT NOT NULL,source_path TEXT NOT NULL,source_generation INTEGER NOT NULL,event_type TEXT NOT NULL,ts_ms INTEGER NOT NULL,event_json TEXT NOT NULL,evidence_seqs TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE event_evidence(event_seq INTEGER NOT NULL,evidence_seq INTEGER NOT NULL,PRIMARY KEY(event_seq,evidence_seq));
      CREATE TABLE memories(memory_id TEXT PRIMARY KEY,content TEXT NOT NULL,scope_json TEXT NOT NULL,evidence_seqs TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,updated_at_ms INTEGER NOT NULL);
      CREATE VIRTUAL TABLE events_fts USING fts5(text,content='',tokenize='unicode61');
      CREATE VIRTUAL TABLE events_fts_trigram USING fts5(text,content='',tokenize='trigram');")?;
    connection.execute(
        "INSERT INTO meta VALUES(1,?1,?2,0)",
        params![SCHEMA_VERSION, generation],
    )?;
    Ok(())
}

fn project_record(tx: &Transaction<'_>, record: &StoredRecord) -> rusqlite::Result<()> {
    if record.kind == KIND_EVIDENCE {
        if let Ok(value) = serde_json::from_slice::<NativeEvidence>(&record.body) {
            tx.execute(
                "INSERT OR IGNORE INTO evidence VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    record.seq,
                    value.provider,
                    value.source_path,
                    value.source_generation,
                    value.byte_start,
                    value.byte_end,
                    value.sha256
                ],
            )?;
        }
    } else if record.kind == KIND_MEMORY {
        if let Ok(value) = serde_json::from_slice::<MemoryRecord>(&record.body) {
            let status = match value.action {
                MemoryAction::Candidate => "candidate",
                MemoryAction::Approve => "approved",
                MemoryAction::Revoke => "revoked",
            };
            tx.execute("INSERT INTO memories VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(memory_id) DO UPDATE SET content=excluded.content,scope_json=excluded.scope_json,evidence_seqs=excluded.evidence_seqs,revision=excluded.revision,status=excluded.status,updated_at_ms=excluded.updated_at_ms WHERE excluded.revision>memories.revision", params![value.memory_id,value.content,serde_json::to_string(&value.scope).unwrap_or_else(|_| "null".into()),serde_json::to_string(&value.evidence_seqs).unwrap_or_else(|_| "[]".into()),value.revision,status,value.updated_at_ms])?;
        }
    } else if record.kind == KIND_CANONICAL_EVENT {
        if let Ok(value) = serde_json::from_slice::<CanonicalEventBody>(&record.body) {
            let event_type = value
                .event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let ts_ms = value
                .event
                .get("timestampMs")
                .and_then(Value::as_u64)
                .unwrap_or(record.ts_ms);
            let event_json = serde_json::to_string(&value.event).unwrap_or_else(|_| "null".into());
            let evidence =
                serde_json::to_string(&value.evidence_seqs).unwrap_or_else(|_| "[]".into());
            tx.execute("UPDATE events SET active=0 WHERE provider=?1 AND source_path=?2 AND source_generation=?3 AND native_identity=?4 AND active=1", params![value.provider,value.source_path,value.source_generation,value.native_identity])?;
            let inserted = tx.execute("INSERT OR IGNORE INTO events(seq,event_id,session_id,native_session_id,native_identity,provider,source_path,source_generation,event_type,ts_ms,event_json,evidence_seqs,active) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1)", params![record.seq,value.event_id,record.session_id.to_hex(),value.native_session_id,value.native_identity,value.provider,value.source_path,value.source_generation,event_type,ts_ms,event_json,evidence])?;
            if inserted > 0 {
                let text = searchable_text(&value.event);
                tx.execute(
                    "INSERT INTO events_fts(rowid,text) VALUES(?1,?2)",
                    params![record.seq, &text],
                )?;
                tx.execute(
                    "INSERT INTO events_fts_trigram(rowid,text) VALUES(?1,?2)",
                    params![record.seq, &text],
                )?;
                for evidence_seq in value.evidence_seqs {
                    tx.execute(
                        "INSERT OR IGNORE INTO event_evidence VALUES(?1,?2)",
                        params![record.seq, evidence_seq],
                    )?;
                }
                let project = value.event.get("project").and_then(Value::as_str);
                let title = value.event.get("title").and_then(Value::as_str);
                tx.execute("INSERT INTO sessions VALUES(?1,?2,?3,?4,?5,1,?6,?6,1) ON CONFLICT(session_id) DO UPDATE SET last_updated_at=max(last_updated_at,excluded.last_updated_at),project=coalesce(excluded.project,project),title=coalesce(excluded.title,title),active=1", params![record.session_id.to_hex(),value.native_session_id,value.provider,project,title,ts_ms])?;
                tx.execute("UPDATE sessions SET event_count=(SELECT count(*) FROM events WHERE session_id=?1 AND active=1),active=EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND active=1) WHERE session_id=?1", [record.session_id.to_hex()])?;
            }
        }
    } else if record.kind == KIND_VISIBILITY {
        if let Ok(value) = serde_json::from_slice::<VisibilityControl>(&record.body) {
            tx.execute("UPDATE events SET active=0 WHERE provider=?1 AND source_path=?2 AND source_generation=?3", params![value.provider,value.source_path,value.source_generation])?;
            tx.execute("UPDATE sessions SET event_count=(SELECT count(*) FROM events WHERE events.session_id=sessions.session_id AND active=1),active=EXISTS(SELECT 1 FROM events WHERE events.session_id=sessions.session_id AND active=1)", [])?;
        }
    } else if record.kind == crate::model::KIND_SOURCE_CHECKPOINT {
        if let Ok(value) = serde_json::from_slice::<crate::model::SourceCheckpoint>(&record.body) {
            tx.execute("INSERT INTO sources VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(provider,source_path) DO UPDATE SET generation=excluded.generation,committed_offset=excluded.committed_offset,snapshot_length=excluded.snapshot_length,chunks_json=excluded.chunks_json", params![value.provider,value.source_path,value.generation,value.committed_offset,value.snapshot_length,serde_json::to_string(&value.chunks).unwrap_or_default()])?;
        }
    }
    Ok(())
}

fn searchable_text(value: &Value) -> String {
    fn visit(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => {
                for v in a {
                    visit(v, out)
                }
            }
            Value::Object(o) => {
                for (k, v) in o {
                    if !matches!(k.as_str(), "encrypted_content" | "signature" | "raw") {
                        visit(v, out)
                    }
                }
            }
            _ => {}
        }
    }
    let mut output = Vec::new();
    visit(value, &mut output);
    output.join("\n")
}

fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let event: String = row.get(4)?;
    let evidence: String = row.get(5)?;
    Ok(
        json!({"seq":row.get::<_,u64>(0)?,"eventId":row.get::<_,String>(1)?,"eventType":row.get::<_,String>(2)?,"timestamp":row.get::<_,u64>(3)?,"event":serde_json::from_str::<Value>(&event).unwrap_or(Value::Null),"evidenceSeqs":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"active":row.get::<_,bool>(6)?}),
    )
}
