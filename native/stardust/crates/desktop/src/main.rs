#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use stardust_runtime::{api::NativeServer, config::Config};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct EmbeddedRuntime {
    shutdown: tokio_util::sync::CancellationToken,
}

fn main() {
    let app = tauri::Builder::default().setup(|app| {
        let address = match std::env::var("STARDUST_DESKTOP_URL") {
            Ok(address) => address,
            Err(_) => {
                let config = Config::load_environment("127.0.0.1:0".parse()?)?;
                if config.frontend_dir.is_none() {return Err("STARDUST_FRONTEND_DIR must select a built frontend for embedded hosting".into());}
                let server = tauri::async_runtime::block_on(NativeServer::bind(config))
                    .map_err(|_| "native runtime initialization failed")?;
                let address = format!("http://{}", server.address);
                app.manage(EmbeddedRuntime {shutdown: server.shutdown.clone()});
                tauri::async_runtime::spawn(async move {let _ = server.run().await;});
                address
            }
        };
        let url = url::Url::parse(&address)?;
        let trusted_loopback = url.host_str().is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
        if !(url.scheme() == "https" || url.scheme() == "http" && trusted_loopback)
            || !url.username().is_empty() || url.password().is_some() {
            return Err("desktop URL requires HTTPS or loopback HTTP without embedded credentials".into());
        }
        WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
            .title("星尘 · Stardust Rust Preview")
            .inner_size(1280.0, 840.0).min_inner_size(800.0, 600.0).build()?;
        Ok(())
    }).build(tauri::generate_context!()).expect("could not create the native desktop shell");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(runtime) = app.try_state::<EmbeddedRuntime>()
        {
            runtime.shutdown.cancel();
        }
    });
}
