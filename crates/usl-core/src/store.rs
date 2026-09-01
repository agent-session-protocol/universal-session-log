//! The store: single-writer, append-only, crash-recoverable.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::Error;
use crate::format::{encode_frame, Header, DATA_START, DEFAULT_PAGE_SIZE};
use crate::identity::SessionId;
use crate::index::{FrameMeta, Index};
use crate::record::{Record, StoredRecord};
use crate::recover;

#[derive(Clone, Copy, Debug)]
pub struct StoreOpts {
    pub page_size: u32,
    pub flags: u32,
}

impl Default for StoreOpts {
    fn default() -> Self {
        StoreOpts {
            page_size: DEFAULT_PAGE_SIZE,
            flags: 0,
        }
    }
}

/// Read-only integrity report produced by `Store::verify`.
#[derive(Debug, Clone, PartialEq)]
pub struct Verification {
    pub data_end: u64,
    pub next_seq: u64,
    pub session_count: u64,
    pub frame_count: u64,
    pub truncation_offset: Option<u64>,
}

pub struct Store {
    file: File,
    path: PathBuf,
    data_end: u64,
    next_seq: u64,
    session_count: u64,
    index: Index,
    opts: StoreOpts,
}

impl Store {
    /// Create a brand-new store. Fails if the path already exists.
    pub fn create(path: impl AsRef<Path>, opts: StoreOpts) -> Result<Store, Error> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path.as_ref())?;
        let header = Header {
            page_size: opts.page_size,
            flags: opts.flags,
            data_end: DATA_START,
            next_seq: 0,
            session_count: 0,
        };
        file.write_all(&header.encode())?;
        file.sync_all()?;
        Ok(Store {
            file,
            path: path.as_ref().to_path_buf(),
            data_end: DATA_START,
            next_seq: 0,
            session_count: 0,
            index: Index::default(),
            opts,
        })
    }

    /// Open an existing store. The header is read as a hint/cross-check only;
    /// correctness always comes from scanning the data region. A torn tail is
    /// physically truncated to the last complete frame.
    pub fn open(path: impl AsRef<Path>, opts: StoreOpts) -> Result<Store, Error> {
        let path = path.as_ref().to_path_buf();
        let mut file = OpenOptions::new().read(true).write(true).open(&path)?;

        // Header is redundant; only try to read it so callers can inspect a
        // corrupted one via recover(). We never depend on its fields.
        file.seek(SeekFrom::Start(DATA_START))?;
        let rec = recover::recover_from(&mut file)?;

        if rec.truncation_offset.is_some() {
            // Physical cleanup: drop the torn tail so later full scans agree
            // and the file doesn't grow garbage.
            file.set_len(rec.data_end)?;
        }
        file.seek(SeekFrom::Start(rec.data_end))?;

        Ok(Store {
            file,
            path,
            data_end: rec.data_end,
            next_seq: rec.next_seq,
            session_count: rec.session_count,
            index: rec.index,
            opts,
        })
    }

    /// Append a record, returning its assigned monotonic `seq`. The record's
    /// payload is framed + CRC'd and written at the current end. No fsync is
    /// performed here (group-commit is the caller's choice via [`flush`]).
    pub fn append(&mut self, rec: &Record) -> Result<u64, Error> {
        let seq = self.next_seq;
        let stored = StoredRecord {
            seq,
            session_id: rec.session_id,
            kind: rec.kind,
            ts_ms: rec.ts_ms,
            body: rec.body.clone(),
        };
        let payload = postcard::to_allocvec(&stored).map_err(|e| Error::Schema(e.to_string()))?;
        let frame = encode_frame(&payload)?;

        self.file.write_all(&frame)?;
        let offset = self.data_end;
        self.data_end += frame.len() as u64;
        self.next_seq += 1;
        let is_new = self.index.push(
            rec.session_id,
            FrameMeta {
                seq,
                offset,
                payload_len: payload.len() as u32,
            },
        );
        if is_new {
            self.session_count += 1;
        }
        Ok(seq)
    }

    /// Append a validated logical batch. If encoding or writing any record
    /// fails, the file and derived in-memory index are restored to their
    /// pre-batch state. Durability is still controlled separately by
    /// [`flush`], allowing callers to group commit explicitly.
    pub fn append_batch(&mut self, records: &[Record]) -> Result<Vec<u64>, Error> {
        let data_end = self.data_end;
        let next_seq = self.next_seq;
        let mut seqs = Vec::with_capacity(records.len());

        for record in records {
            match self.append(record) {
                Ok(seq) => seqs.push(seq),
                Err(error) => {
                    self.file.set_len(data_end)?;
                    self.file.seek(SeekFrom::Start(data_end))?;
                    self.data_end = data_end;
                    self.next_seq = next_seq;
                    self.index.truncate_from_seq(next_seq);
                    self.session_count = self.index.session_count();
                    return Err(error);
                }
            }
        }
        Ok(seqs)
    }

    /// Durability ordering: sync data first, then rewrite the header, then
    /// sync metadata. This is the "handoff export full-fsync" path.
    pub fn flush(&mut self) -> Result<(), Error> {
        self.file.sync_data()?;
        let header = Header {
            page_size: self.opts.page_size,
            flags: self.opts.flags,
            data_end: self.data_end,
            next_seq: self.next_seq,
            session_count: self.session_count,
        };
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&header.encode())?;
        self.file.sync_all()?;
        self.file.seek(SeekFrom::Start(self.data_end))?;
        Ok(())
    }

    /// All records for a session with `seq >= from_seq`, in ascending seq.
    pub fn scan(&self, session: &SessionId, from_seq: u64) -> Result<Vec<StoredRecord>, Error> {
        self.scan_limited(session, from_seq, usize::MAX)
    }

    /// At most `limit` records for one session, preserving global sequence
    /// order without materializing the rest of the session.
    pub fn scan_limited(
        &self,
        session: &SessionId,
        from_seq: u64,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, Error> {
        let Some(metas) = self.index.frames(session) else {
            return Ok(Vec::new());
        };
        let mut reader = OpenOptions::new().read(true).open(&self.path)?;
        let mut out = Vec::new();
        for m in metas {
            if m.seq < from_seq {
                continue;
            }
            if out.len() == limit {
                break;
            }
            out.push(read_frame_at(&mut reader, *m)?);
        }
        Ok(out)
    }

    pub fn get(&self, session: &SessionId, seq: u64) -> Result<Option<StoredRecord>, Error> {
        let Some(metas) = self.index.frames(session) else {
            return Ok(None);
        };
        let mut reader = OpenOptions::new().read(true).open(&self.path)?;
        for m in metas {
            if m.seq == seq {
                return Ok(Some(read_frame_at(&mut reader, *m)?));
            }
        }
        Ok(None)
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn data_end(&self) -> u64 {
        self.data_end
    }

    pub fn session_count(&self) -> u64 {
        self.session_count
    }

    /// All known session ids in deterministic hexadecimal order. The index is
    /// derived from the append log, so this never reads untrusted header state.
    pub fn session_ids(&self) -> Vec<SessionId> {
        let mut ids: Vec<_> = self.index.sessions().copied().collect();
        ids.sort_by_key(SessionId::to_hex);
        ids
    }

    /// Scan the complete valid log prefix in global sequence order.
    ///
    /// This is intentionally a management/query primitive rather than an
    /// append-path optimization. Future checkpoint indexes can replace the
    /// current replay-backed implementation without changing callers.
    pub fn scan_all(&self, from_seq: u64) -> Result<Vec<StoredRecord>, Error> {
        self.scan_all_limited(from_seq, usize::MAX)
    }

    /// At most `limit` records in global sequence order. The global frame
    /// index is derived entirely from replay and contains metadata only, so a
    /// bounded query never materializes unrelated record bodies.
    pub fn scan_all_limited(
        &self,
        from_seq: u64,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, Error> {
        let mut reader = OpenOptions::new().read(true).open(&self.path)?;
        let mut out = Vec::with_capacity(limit.min(1024));
        for (_, meta) in self.index.global_frames() {
            if meta.seq < from_seq {
                continue;
            }
            if out.len() == limit {
                break;
            }
            out.push(read_frame_at(&mut reader, *meta)?);
        }
        Ok(out)
    }

    /// Read-only integrity check of a store file without opening it for write.
    pub fn verify(path: impl AsRef<Path>) -> Result<Verification, Error> {
        let mut file = OpenOptions::new().read(true).open(path)?;
        file.seek(SeekFrom::Start(DATA_START))?;
        let rec = recover::recover_from(&mut file)?;
        Ok(Verification {
            data_end: rec.data_end,
            next_seq: rec.next_seq,
            session_count: rec.session_count,
            frame_count: rec.index.total_frames(),
            truncation_offset: rec.truncation_offset,
        })
    }
}

fn read_frame_at(reader: &mut File, m: FrameMeta) -> Result<StoredRecord, Error> {
    reader.seek(SeekFrom::Start(m.offset + 8))?;
    let mut payload = vec![0u8; m.payload_len as usize];
    reader.read_exact(&mut payload)?;
    // Defense in depth: re-verify CRC on every read.
    let stored_crc = {
        let mut crc_buf = [0u8; 4];
        reader.seek(SeekFrom::Start(m.offset + 4))?;
        reader.read_exact(&mut crc_buf)?;
        u32::from_le_bytes(crc_buf)
    };
    if crc32fast::hash(&payload) != stored_crc {
        return Err(Error::Corrupt(format!(
            "frame at offset {} failed CRC on read",
            m.offset
        )));
    }
    postcard::from_bytes(&payload).map_err(|e| Error::Schema(e.to_string()))
}
