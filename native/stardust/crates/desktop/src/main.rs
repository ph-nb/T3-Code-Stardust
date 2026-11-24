#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use stardust_runtime::{api::NativeServer, config::Config};
use std::io::Write;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

mod launch;

use launch::{LaunchMode, launch_mode};

struct EmbeddedRuntime {
    shutdown: tokio_util::sync::CancellationToken,
}

fn main() {
    let app = tauri::Builder::default().setup(|app| {
        let address = std::env::var("STARDUST_DESKTOP_URL").ok();
        let mode = launch_mode(address.as_deref(), std::env::var_os("STARDUST_STATE_DIR").is_some())?;
        let (url, title, mode_name) = match mode {
            LaunchMode::Bundled => (WebviewUrl::App("index.html".into()), "星尘 · Rust 预览版 · 连接模式", "bundled"),
            LaunchMode::Remote(url) => (WebviewUrl::External(url), "星尘 · Rust 预览版", "remote"),
            LaunchMode::Embedded => {
                let config = Config::load_environment("127.0.0.1:0".parse()?)?;
                if config.frontend_dir.is_none() {return Err("STARDUST_FRONTEND_DIR must select a built frontend for embedded hosting".into());}
                let server = tauri::async_runtime::block_on(NativeServer::bind(config))
                    .map_err(|_| "native runtime initialization failed")?;
                let address = format!("http://{}", server.address);
                diagnostic(app.handle(), &format!("embedded-listener={address}"));
                app.manage(EmbeddedRuntime {shutdown: server.shutdown.clone()});
                tauri::async_runtime::spawn(async move {let _ = server.run().await;});
                (WebviewUrl::External(address.parse()?), "星尘 · Rust 预览版 · 本地服务测试", "embedded")
            }
        };
        diagnostic(app.handle(), &format!("shell-started mode={mode_name}"));
        WebviewWindowBuilder::new(app, "main", url)
            .title(title)
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    diagnostic(window.app_handle(), &format!("webview-loaded mode={mode_name}"));
                }
            })
            .inner_size(1280.0, 840.0).min_inner_size(800.0, 600.0).build()?;
        Ok(())
    }).build(tauri::generate_context!()).expect("could not create the native desktop shell");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(runtime) = app.try_state::<EmbeddedRuntime>()
        {
            runtime.shutdown.cancel();
        }
        if matches!(event, tauri::RunEvent::Exit) {
            diagnostic(app, "shell-exited");
        }
    });
}

fn diagnostic(app: &tauri::AppHandle, event: &str) {
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("startup.log"))
    {
        let _ = writeln!(
            log,
            "pid={} version={} {event}",
            std::process::id(),
            env!("CARGO_PKG_VERSION")
        );
    }
}
