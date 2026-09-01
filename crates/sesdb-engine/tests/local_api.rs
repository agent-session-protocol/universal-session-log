use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Daemon {
    child: Child,
    home: PathBuf,
    port: u16,
    token: String,
}

impl Daemon {
    fn start() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home =
            std::env::temp_dir().join(format!("sesdb-local-api-{}-{nonce}", std::process::id()));
        let mut child = Command::new(env!("CARGO_BIN_EXE_sesdbd"))
            .env("SESDB_HOME", &home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let descriptor = home.join("run/daemon.json");
        let deadline = Instant::now() + Duration::from_secs(5);
        let value: Value = loop {
            if let Ok(bytes) = std::fs::read(&descriptor) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    break value;
                }
            }
            assert!(child.try_wait().unwrap().is_none(), "daemon exited early");
            assert!(Instant::now() < deadline, "daemon descriptor timed out");
            std::thread::sleep(Duration::from_millis(20));
        };
        let base_url = value["baseUrl"].as_str().unwrap();
        Self {
            child,
            home,
            port: base_url.rsplit_once(':').unwrap().1.parse().unwrap(),
            token: value["token"].as_str().unwrap().to_owned(),
        }
    }

    fn request(&self, host: &str, origin: Option<&str>) -> (u16, Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let origin = origin
            .map(|value| format!("Origin: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "GET /health HTTP/1.1\r\nHost: {host}\r\n{origin}Authorization: Bearer {}\r\nConnection: close\r\n\r\n",
            self.token
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status = head
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, serde_json::from_str(body).unwrap())
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn host_and_origin_are_compared_as_exact_local_authorities() {
    let daemon = Daemon::start();
    let authority = format!("127.0.0.1:{}", daemon.port);
    let (status, body) = daemon.request(&authority, Some(&format!("http://{authority}")));
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);

    let (status, body) = daemon.request(&format!("{authority}.evil.example"), None);
    assert_eq!(status, 403);
    assert_eq!(body["code"], "permission_denied");
    assert!(body.get("details").is_some());

    let (status, body) = daemon.request(&authority, Some(&format!("http://{authority}.evil")));
    assert_eq!(status, 403);
    assert_eq!(body["code"], "permission_denied");
    assert!(body.get("details").is_some());
}
