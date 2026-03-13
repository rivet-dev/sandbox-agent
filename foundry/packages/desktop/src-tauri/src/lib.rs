use std::sync::Mutex;

#[cfg(not(mobile))]
use tauri::{LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(not(mobile))]
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(mobile))]
use tauri_plugin_shell::ShellExt;

struct BackendState {
    #[cfg(not(mobile))]
    child: Mutex<Option<CommandChild>>,
    backend_url: Mutex<String>,
}

#[tauri::command]
fn get_backend_url(state: tauri::State<BackendState>) -> String {
    state.backend_url.lock().unwrap().clone()
}

#[tauri::command]
fn set_backend_url(url: String, state: tauri::State<BackendState>) {
    *state.backend_url.lock().unwrap() = url;
}

#[tauri::command]
async fn backend_health(state: tauri::State<'_, BackendState>) -> Result<bool, String> {
    let base = state.backend_url.lock().unwrap().clone();
    let url = format!("{}/api/rivet/metadata", base);
    match reqwest::get(&url).await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[cfg(not(mobile))]
async fn wait_for_backend(base_url: String, timeout_secs: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);
    let url = format!("{}/api/rivet/metadata", base_url);

    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "Backend failed to start within {} seconds",
                timeout_secs
            ));
        }

        match reqwest::get(&url).await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[cfg(not(mobile))]
fn spawn_backend(app: &tauri::AppHandle) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("sidecars/foundry-backend")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["start", "--host", "127.0.0.1", "--port", "7741"]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn backend sidecar: {}", e))?;

    // Store the child process handle for cleanup
    let state = app.state::<BackendState>();
    *state.child.lock().unwrap() = Some(child);

    // Log sidecar stdout/stderr in a background task
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[foundry-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[foundry-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[foundry-backend] process exited with code {:?}",
                        payload.code
                    );
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[foundry-backend] error: {}", err);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Shell plugin is desktop-only (used for sidecar spawning)
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_shell::init());

    builder
        .manage(BackendState {
            #[cfg(not(mobile))]
            child: Mutex::new(None),
            backend_url: Mutex::new("http://127.0.0.1:7741".to_string()),
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            set_backend_url,
            backend_health
        ])
        .setup(|_app| {
            #[cfg(not(mobile))]
            let app = _app;
            // On desktop, create window programmatically for traffic light position
            #[cfg(not(mobile))]
            {
                let url = if cfg!(debug_assertions) {
                    WebviewUrl::External("http://localhost:4173".parse().unwrap())
                } else {
                    WebviewUrl::default()
                };

                let mut win_builder = WebviewWindowBuilder::new(app, "main", url)
                    .title("Foundry")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(900.0, 600.0)
                    .resizable(true)
                    .theme(Some(tauri::Theme::Dark))
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);

                #[cfg(target_os = "macos")]
                {
                    win_builder =
                        win_builder.traffic_light_position(LogicalPosition::new(14.0, 14.0));
                }

                win_builder.build()?;
            }

            // On mobile, Tauri creates the webview automatically — no window setup needed.
            // The backend URL will be set by the frontend via set_backend_url.

            // Sidecar spawning is desktop-only
            #[cfg(not(mobile))]
            {
                // In debug mode, assume the developer is running the backend externally
                if cfg!(debug_assertions) {
                    eprintln!(
                        "[foundry] Dev mode: skipping sidecar spawn. Run the backend separately."
                    );
                    return Ok(());
                }

                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = spawn_backend(&handle) {
                        eprintln!("[foundry] Failed to start backend: {}", e);
                        return;
                    }

                    match wait_for_backend("http://127.0.0.1:7741".to_string(), 30).await {
                        Ok(()) => eprintln!("[foundry] Backend is ready."),
                        Err(e) => eprintln!("[foundry] {}", e),
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                #[cfg(not(mobile))]
                {
                    let state = window.state::<BackendState>();
                    let child = state.child.lock().unwrap().take();
                    if let Some(child) = child {
                        let _ = child.kill();
                        eprintln!("[foundry] Backend sidecar killed.");
                    }
                }
                let _ = window; // suppress unused warning on mobile
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Foundry");
}
