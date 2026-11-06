mod pi;
mod repository;

use tauri::Manager;

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn analyze_repository(
    app: tauri::AppHandle,
    state: tauri::State<'_, pi::PiState>,
    id: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let bridge=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard=bridge.repository_scan.try_lock().map_err(|_| "Ya hay un repositorio en análisis.")?;
        let path=if let Some(id)=id {
            let saved=bridge.request(&app,"repository_get",serde_json::json!({"id":id}))?;
            std::path::PathBuf::from(saved["path"].as_str().ok_or("El informe no tiene una carpeta válida.")?)
        } else {
            let window=app.get_webview_window("main").ok_or("No se encontró la ventana.")?;
            let selected=app.dialog().file().set_parent(&window).set_title("Analizar repositorio").blocking_pick_folder();
            let Some(selected)=selected else {return Ok(None);};
            selected.into_path().map_err(|_| "No se pudo interpretar la carpeta seleccionada.")?
        };
        bridge.authorize_project(&path)?;
        let report=bridge.request(&app,"analyze_repository",serde_json::json!({}))?;
        Ok(Some(report))
    }).await.map_err(|_|"No se pudo analizar el repositorio.".to_string())?
}

#[tauri::command]
async fn pi_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, pi::PiState>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bridge.request(&app, &method, params))
        .await
        .map_err(|_| "No se pudo completar la solicitud a Pi.".to_string())?
}

#[tauri::command]
fn pi_open_auth_url(url: String) -> Result<(), String> {
    pi::open_auth_url(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pi::PiState::default())
        .invoke_handler(tauri::generate_handler![
            analyze_repository,
            pi_request,
            pi_open_auth_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevGuard")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<pi::PiState>().shutdown();
            }
        });
}
