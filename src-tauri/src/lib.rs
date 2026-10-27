mod detection;
mod project;

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn detect_tools() -> Result<Vec<detection::ToolDetection>, String> {
    tauri::async_runtime::spawn_blocking(detection::detect_tools)
        .await
        .map_err(|_| "No se pudo completar la detección local.".to_string())
}

#[tauri::command]
async fn choose_node_project(
    app: tauri::AppHandle,
) -> Result<Option<project::ProjectReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Elegir proyecto de Node")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "No se pudo interpretar la carpeta seleccionada.".to_string())?;
        project::read_project(&path).map(Some)
    })
    .await
    .map_err(|_| "No se pudo completar la lectura del proyecto.".to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![detect_tools, choose_node_project])
        .run(tauri::generate_context!())
        .expect("error while running DevGuard");
}
