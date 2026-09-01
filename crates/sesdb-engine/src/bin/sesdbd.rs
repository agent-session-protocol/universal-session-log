use sesdb_engine::{daemon, Paths};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let descriptor = daemon::run(Paths::default_home())
        .await
        .map_err(std::io::Error::other)?;
    eprintln!("sesdbd listening on {}", descriptor.base_url);
    loop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => { result?; break; }
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                if !Paths::default_home().descriptor.exists() { break; }
            }
        }
    }
    Ok(())
}
