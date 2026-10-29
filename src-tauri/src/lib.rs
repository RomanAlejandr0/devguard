mod detection;
mod inventory;
mod pi;
mod project;

use tauri::Manager;

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn collect_inventory() -> Result<Vec<inventory::ManagerInventory>, String> {
    tauri::async_runtime::spawn_blocking(inventory::collect_inventory)
        .await
        .map_err(|_| "No se pudo completar el inventario local.".to_string())
}

#[tauri::command]
async fn detect_tools() -> Result<Vec<detection::ToolDetection>, String> {
    tauri::async_runtime::spawn_blocking(detection::detect_tools)
        .await
        .map_err(|_| "No se pudo completar la detección local.".to_string())
}

#[tauri::command]
async fn choose_node_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, pi::PiState>,
) -> Result<Option<serde_json::Value>, String> {
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let window = app.get_webview_window("main")
            .ok_or("No se encontró la ventana de DevGuard.")?;
        let selected = app.dialog().file()
            .set_parent(&window)
            .set_title("Agregar proyecto")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "No se pudo interpretar la carpeta seleccionada.".to_string())?;
        bridge.authorize_project(&path)?;
        let report=bridge.request(&app,"analyze_project",serde_json::json!({}))
            .map_err(|_| "Pi no pudo completar el análisis. Revisa proveedor y modelo en Configuración IA y vuelve a intentarlo.".to_string())?;
        Ok(Some(report))
    })
    .await
    .map_err(|_| "No se pudo completar la lectura del proyecto.".to_string())?
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
            detect_tools,
            choose_node_project,
            collect_inventory,
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
