#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use stardust_runtime::{api::NativeServer, config::Config, local::LocalServer};
use std::{io::Write, sync::Arc};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

mod launch;
use launch::{LaunchMode, launch_mode};

struct EmbeddedRuntime {
    shutdown: tokio_util::sync::CancellationToken,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("could not create the native desktop shell");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(runtime) = app.try_state::<EmbeddedRuntime>() {
                runtime.shutdown.cancel();
            }
            diagnostic(app, "shell-exited");
        }
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let address = std::env::var("STARDUST_DESKTOP_URL").ok();
    let mode = launch_mode(
        address.as_deref(),
        std::env::var_os("STARDUST_STATE_DIR").is_some(),
    )?;
    let mut profile_directory = None;
    let (url, title, mode_name, bootstrap_script) = match mode {
        LaunchMode::Local => {
            let directory = match std::env::var_os("STARDUST_LOCAL_DATA_DIR") {
                Some(directory) => std::path::PathBuf::from(directory),
                None => app.path().app_local_data_dir()?.join("local-runtime-v1"),
            };
            if !directory.is_absolute() {
                return Err("the local data directory must be absolute".into());
            }
            profile_directory = Some(directory.join("webview-profile"));
            let server =
                tauri::async_runtime::block_on(LocalServer::bind(directory, Arc::new(|_| None)))
                    .map_err(|_| "could not initialize the local Rust runtime")?;
            let script = format!(
                "if (window === window.top && ((location.protocol === 'http:' && location.host === 'tauri.localhost') || (location.protocol === 'tauri:' && location.host === 'localhost'))) {{ Object.defineProperty(window, '__STARDUST_NATIVE__', {{value: Object.freeze({}), configurable: false, writable: false}}); }}",
                server.desktop_bootstrap()
            );
            diagnostic(
                app.handle(),
                &format!("local-listener=http://{}", server.address),
            );
            app.manage(EmbeddedRuntime {
                shutdown: server.shutdown.clone(),
            });
            tauri::async_runtime::spawn(async move {
                let _ = server.run().await;
            });
            (
                WebviewUrl::App("index.html".into()),
                "星尘 · Rust 本机预览版",
                "local",
                Some(script),
            )
        }
        LaunchMode::Remote(url) => (
            WebviewUrl::External(url),
            "星尘 · Rust 预览版",
            "remote",
            None,
        ),
        LaunchMode::Embedded => {
            let config = Config::load_environment("127.0.0.1:0".parse()?)?;
            if config.frontend_dir.is_none() {
                return Err(
                    "STARDUST_FRONTEND_DIR must select a built frontend for embedded hosting"
                        .into(),
                );
            }
            let server = tauri::async_runtime::block_on(NativeServer::bind(config))
                .map_err(|_| "native runtime initialization failed")?;
            let address = format!("http://{}", server.address);
            diagnostic(app.handle(), &format!("embedded-listener={address}"));
            app.manage(EmbeddedRuntime {
                shutdown: server.shutdown.clone(),
            });
            tauri::async_runtime::spawn(async move {
                let _ = server.run().await;
            });
            (
                WebviewUrl::External(address.parse()?),
                "星尘 · Rust 预览版 · 本地服务测试",
                "embedded",
                None,
            )
        }
    };
    diagnostic(app.handle(), &format!("shell-started mode={mode_name}"));
    let mut window = WebviewWindowBuilder::new(app, "main", url)
        .title(title)
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                diagnostic(
                    window.app_handle(),
                    &format!("webview-loaded mode={mode_name}"),
                );
            }
        })
        .on_new_window(|url, _| {
            if url.scheme() == "https"
                || (url.scheme() == "http"
                    && url
                        .host_str()
                        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]")))
            {
                let _ = open::that_detached(url.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .inner_size(1280.0, 840.0)
        .min_inner_size(800.0, 600.0);
    if let Some(script) = bootstrap_script {
        window = window.initialization_script(script);
    }
    if let Some(directory) = profile_directory {
        window = window.data_directory(directory);
    }
    if std::env::var_os("STARDUST_NATIVE_HIDDEN_TEST").is_some() {
        window = window.visible(false);
    }
    window.build()?;
    Ok(())
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
