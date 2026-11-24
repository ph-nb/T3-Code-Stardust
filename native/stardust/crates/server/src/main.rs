use clap::Parser;
use stardust_runtime::{
    api::NativeServer,
    config::{Config, Secret, initialize_state},
};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(
    version,
    about = "Stardust Rust runtime preview; existing T3 clients are not yet protocol compatible"
)]
struct Arguments {
    #[arg(long, env = "STARDUST_STATE_DIR")]
    data_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1:3774")]
    listen: SocketAddr,
    #[arg(long, env = "STARDUST_FRONTEND_DIR")]
    frontend_dir: Option<PathBuf>,
    #[arg(long, default_value = "stardust_rust_preview")]
    schema: String,
    #[arg(long, env = "STARDUST_TOKEN_FILE")]
    token_file: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Arguments::parse();
    let database_url = std::env::var("T3CODE_DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("T3CODE_DATABASE_URL is required"))?;
    let token = std::fs::read_to_string(args.token_file)
        .map_err(|_| anyhow::anyhow!("could not read the bearer token file"))?;
    let config = Config {
        listen: args.listen,
        environment_id: initialize_state(&args.data_dir)?,
        data_dir: args.data_dir,
        frontend_dir: args.frontend_dir,
        schema: args.schema,
        database_url: Secret::new(database_url),
        redis_url: std::env::var("T3CODE_REDIS_URL").ok().map(Secret::new),
        token: Secret::new(token.trim().to_owned()),
    };
    let server = NativeServer::bind(config).await.map_err(|_| anyhow::anyhow!("native runtime initialization failed; check PostgreSQL configuration, schema ownership and environment identity"))?;
    tracing::info!(address=%server.address,"Stardust Rust preview ready; full client protocol migration is pending");
    let shutdown = server.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    server.run().await?;
    Ok(())
}
