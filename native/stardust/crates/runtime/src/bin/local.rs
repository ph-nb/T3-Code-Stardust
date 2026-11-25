use clap::Parser;
use stardust_runtime::local::{AssetLoader, LocalAsset, LocalServer};
use std::{io::Write, path::PathBuf, sync::Arc};

#[derive(Parser)]
struct Options {
    #[arg(long)]
    state_dir: PathBuf,
    #[arg(long)]
    bootstrap_file: PathBuf,
    #[arg(long)]
    frontend_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let options = Options::parse();
    let assets: AssetLoader = Arc::new(move |name| {
        let root = options.frontend_dir.as_ref()?.canonicalize().ok()?;
        let selected = root.join(name).canonicalize().ok()?;
        if !selected.starts_with(&root) {
            return None;
        }
        let bytes = std::fs::read(&selected).ok()?;
        let mime = match selected
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
        {
            "html" => "text/html; charset=utf-8",
            "js" | "mjs" => "text/javascript",
            "css" => "text/css",
            "wasm" => "application/wasm",
            "json" => "application/json",
            _ => "application/octet-stream",
        };
        Some(LocalAsset {
            bytes,
            mime_type: mime.into(),
            csp: None,
        })
    });
    let server = LocalServer::bind(options.state_dir, assets).await?;
    let mut bootstrap_options = std::fs::OpenOptions::new();
    bootstrap_options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        bootstrap_options.mode(0o600);
    }
    bootstrap_options
        .open(options.bootstrap_file)?
        .write_all(server.launch_url().as_bytes())?;
    println!("local-listener=http://{}", server.address);
    let shutdown = server.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    server.run().await?;
    Ok(())
}
