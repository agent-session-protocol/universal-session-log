//! Minimal FUSE smoke test: mount a read-only fs exposing one file.
//! Purpose: prove that a fuser-based mount actually works on this machine
//! against fuse-t's libfuse-t (via install_name_tool swap). NOT the real
//! capture fs — that comes after this mounts successfully.

use std::ffi::OsStr;
use std::time::{Duration, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry,
    Request,
};
use libc::ENOENT;

const TTL: Duration = Duration::from_secs(1);

const DIR_ATTR: FileAttr = FileAttr {
    ino: 1, size: 0, blocks: 0, atime: UNIX_EPOCH, mtime: UNIX_EPOCH, ctime: UNIX_EPOCH,
    crtime: UNIX_EPOCH, kind: FileType::Directory, perm: 0o755, nlink: 2, uid: 501, gid: 20,
    rdev: 0, flags: 0, blksize: 512,
};
const FILE_ATTR: FileAttr = FileAttr {
    ino: 2, size: 6, blocks: 1, atime: UNIX_EPOCH, mtime: UNIX_EPOCH, ctime: UNIX_EPOCH,
    crtime: UNIX_EPOCH, kind: FileType::RegularFile, perm: 0o644, nlink: 1, uid: 501, gid: 20,
    rdev: 0, flags: 0, blksize: 512,
};

struct SmokeFs;

impl Filesystem for SmokeFs {
    fn lookup(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        if parent == 1 && name.to_str() == Some("hello.txt") {
            reply.entry(&TTL, &FILE_ATTR, 0);
        } else {
            reply.error(ENOENT);
        }
    }

    fn getattr(&mut self, _req: &Request, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        match ino {
            1 => reply.attr(&TTL, &DIR_ATTR),
            2 => reply.attr(&TTL, &FILE_ATTR),
            _ => reply.error(ENOENT),
        }
    }

    fn read(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        _size: u32,
        _flags: i32,
        _lock: Option<u64>,
        reply: ReplyData,
    ) {
        if ino == 2 {
            reply.data(&b"smoke\n"[offset as usize..]);
        } else {
            reply.error(ENOENT);
        }
    }

    fn readdir(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        if ino != 1 {
            reply.error(ENOENT);
            return;
        }
        for (i, entry) in [(1u64, FileType::Directory, "."), (1, FileType::Directory, ".."), (2, FileType::RegularFile, "hello.txt")]
            .into_iter()
            .enumerate()
            .skip(offset as usize)
        {
            if reply.add(entry.0, (i + 1) as i64, entry.1, entry.2) {
                break;
            }
        }
        reply.ok();
    }
}

fn main() {
    let mountpoint = std::env::args().nth(1).expect("usage: usl-fuse <mountpoint>");
    let options = vec![
        MountOption::RO,
        MountOption::FSName("usl-smoke".to_string()),
        MountOption::AutoUnmount,
    ];
    fuser::mount2(SmokeFs, &mountpoint, &options).expect("mount failed");
}
