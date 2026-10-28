//! Restricted persistent bridge to the local Pi SDK sidecar.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

const LINE_LIMIT: usize = 2 * 1024 * 1024;
const METHODS: &[&str] = &[
    "catalog",
    "analyze",
    "cancel",
    "auth_set",
    "auth_check",
    "auth_login",
    "auth_input",
    "auth_logout",
    "auth_import",
];
const TOOLS: &[&str] = &[
    "detect_tools",
    "collect_inventory",
];
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Reply>>>>;
type Writer = Arc<Mutex<ChildStdin>>;

#[derive(Clone, Default)]
pub struct PiState {
    inner: Arc<PiInner>,
}
#[derive(Default)]
struct PiInner {
    process: Mutex<Option<BridgeProcess>>,
    selected_project: Arc<Mutex<Option<PathBuf>>>,
    sequence: AtomicU64,
}
struct BridgeProcess {
    child: Child,
    writer: Writer,
    pending: Pending,
    alive: Arc<AtomicBool>,
    generation: u64,
}
impl Drop for BridgeProcess {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        fail_pending(&self.pending, "La conexión con Pi se cerró.");
    }
}

impl PiState {
    pub fn authorize_project(&self, selected: &Path) -> Result<(), String> {
        let root = selected
            .canonicalize()
            .map_err(|_| "No se pudo autorizar la carpeta seleccionada.".to_string())?;
        if !root.is_dir() {
            return Err("La carpeta seleccionada no está disponible.".into());
        }
        *self
            .inner
            .selected_project
            .lock()
            .map_err(|_| "No se pudo guardar la carpeta autorizada.".to_string())? = Some(root);
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut process) = self.inner.process.lock() {
            process.take();
        }
    }

    fn connection(&self, app: &tauri::AppHandle) -> Result<(Writer, Pending), String> {
        let mut guard = self
            .inner
            .process
            .lock()
            .map_err(|_| "No se pudo acceder al agente Pi.".to_string())?;
        if let Some(process) = guard.as_mut() {
            if process.alive.load(Ordering::SeqCst) && matches!(process.child.try_wait(), Ok(None))
            {
                return Ok((process.writer.clone(), process.pending.clone()));
            }
        }
        guard.take();
        let script = sidecar_path(app)?;
        let node = find_node().ok_or("No se encontró Node.js para iniciar el agente Pi.")?;
        let data = app
            .path()
            .app_data_dir()
            .map_err(|_| "No se pudo acceder a los datos locales de Pi.".to_string())?
            .join("pi");
        fs::create_dir_all(&data)
            .map_err(|_| "No se pudo crear el almacenamiento privado de Pi.".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))
                .map_err(|_| "No se pudo proteger el almacenamiento de Pi.".to_string())?;
        }
        let mut command = Command::new(&node);
        command
            .arg(&script)
            .current_dir(
                script
                    .parent()
                    .ok_or("No se encontró la carpeta del agente Pi.")?,
            )
            .env("DEVGUARD_PI_DIR", &data)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SDK auth helpers can locate the same Node executable without reading shell startup files.
        let mut directories = search_directories();
        if let Some(parent) = node.parent() {
            directories.insert(0, parent.to_path_buf());
        }
        if let Ok(path) = std::env::join_paths(directories) {
            command.env("PATH", path);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "No se pudo iniciar el agente Pi.".to_string())?;
        let writer = Arc::new(Mutex::new(
            child
                .stdin
                .take()
                .ok_or("No se pudo abrir la conexión con Pi.")?,
        ));
        let output = child
            .stdout
            .take()
            .ok_or("No se pudo leer la conexión con Pi.")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let generation = self.inner.sequence.fetch_add(1, Ordering::Relaxed);
        let process = BridgeProcess {
            child,
            writer: writer.clone(),
            pending: pending.clone(),
            alive: alive.clone(),
            generation,
        };
        let weak = Arc::downgrade(&self.inner);
        let selected = self.inner.selected_project.clone();
        let app = app.clone();
        let reader_writer = writer.clone();
        let reader_pending = pending.clone();
        thread::spawn(move || {
            let tool_workers = Arc::new(AtomicUsize::new(0));
            let mut reader = BufReader::new(output);
            loop {
                let line = match read_line_bounded(&mut reader) {
                    Ok(Some(line)) => line,
                    _ => break,
                };
                let frame: Value = match serde_json::from_slice(&line) {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                if let Some(id) = frame.get("id").and_then(Value::as_str) {
                    let sender = reader_pending
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(id));
                    if let Some(sender) = sender {
                        let result = if frame.get("error").is_some() {
                            // SDK/provider errors can contain credentials or request headers. Do not relay raw errors.
                            Err("Pi no pudo completar la solicitud. Revisa el proveedor, el modelo y la conexión.".into())
                        } else if let Some(result) = frame.get("result") {
                            Ok(result.clone())
                        } else {
                            Err("Pi devolvió una respuesta incompleta.".into())
                        };
                        let _ = sender.send(result);
                    }
                } else if frame.get("toolCallId").is_some() {
                    let Some(id) = frame
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty() && id.len() <= 128)
                        .map(str::to_owned)
                    else {
                        break;
                    };
                    let tool = frame
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !TOOLS.contains(&tool.as_str()) {
                        let _ = write_frame(
                            &reader_writer,
                            &json!({"toolResultId":id,"error":"Herramienta no autorizada."}),
                        );
                        continue;
                    }
                    if tool_workers.fetch_add(1, Ordering::SeqCst) >= 4 {
                        tool_workers.fetch_sub(1, Ordering::SeqCst);
                        let _ = write_frame(
                            &reader_writer,
                            &json!({"toolResultId":id,"error":"Hay demasiadas lecturas en curso."}),
                        );
                        continue;
                    }
                    let workers = tool_workers.clone();
                    let writer = reader_writer.clone();
                    let selected = selected.clone();
                    thread::spawn(move || {
                        // Caller-supplied arguments never select executables, commands or paths.
                        let result = dispatch_tool(&tool, &selected);
                        let reply = match result {
                            Ok(result) => json!({"toolResultId":id,"result":result}),
                            Err(error) => json!({"toolResultId":id,"error":error}),
                        };
                        let _ = write_frame(&writer, &reply);
                        workers.fetch_sub(1, Ordering::SeqCst);
                    });
                } else if frame.get("event").and_then(Value::as_str).is_some() {
                    let _ = app.emit("pi-event", &frame);
                } else {
                    break;
                }
            }
            alive.store(false, Ordering::SeqCst);
            fail_pending(
                &reader_pending,
                "La conexión con Pi terminó antes de completar la solicitud.",
            );
            if let Some(inner) = weak.upgrade() {
                if let Ok(mut process) = inner.process.lock() {
                    if process
                        .as_ref()
                        .is_some_and(|process| process.generation == generation)
                    {
                        process.take();
                    }
                }
            }
        });
        *guard = Some(process);
        Ok((writer, pending))
    }

    pub fn request(&self, app: &tauri::AppHandle, method: &str, params: Value) -> Reply {
        validate_request(method, &params)?;
        let (writer, pending) = self.connection(app)?;
        let id = format!(
            "request-{}",
            self.inner.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = pending
                .lock()
                .map_err(|_| "No se pudo registrar la solicitud a Pi.".to_string())?;
            if pending.len() >= 64 {
                return Err("Hay demasiadas solicitudes pendientes a Pi.".into());
            }
            pending.insert(id.clone(), sender);
        }
        if let Err(error) = write_frame(&writer, &json!({"id":id,"method":method,"params":params}))
        {
            if let Ok(mut pending) = pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        let timeout = if method == "analyze" { 300 } else { 180 };
        match receiver.recv_timeout(Duration::from_secs(timeout)) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = pending.lock() {
                    pending.remove(&id);
                }
                if method == "analyze" {
                    let cancel_id = format!(
                        "timeout-{}",
                        self.inner.sequence.fetch_add(1, Ordering::Relaxed)
                    );
                    let _ = write_frame(
                        &writer,
                        &json!({"id":cancel_id,"method":"cancel","params":{}}),
                    );
                }
                Err("Pi superó el tiempo de espera. Puedes volver a intentar la solicitud.".into())
            }
        }
    }
}

fn validate_request(method: &str, params: &Value) -> Result<(), String> {
    if !METHODS.contains(&method) {
        return Err("Esta operación de Pi no está autorizada.".into());
    }
    if !params.is_object() {
        return Err("Los parámetros de Pi deben ser un objeto.".into());
    }
    if serde_json::to_vec(params)
        .map_err(|_| "No se pudo preparar la solicitud a Pi.".to_string())?
        .len()
        > LINE_LIMIT / 2
    {
        return Err("La solicitud a Pi supera el tamaño permitido.".into());
    }
    Ok(())
}

fn sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let script = resources.join("agent/sidecar.mjs");
        if script.is_file() {
            return Ok(script);
        }
    }
    #[cfg(debug_assertions)]
    {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent/sidecar.mjs");
        if script.is_file() {
            return Ok(script);
        }
    }
    Err("No se encontraron los archivos del agente Pi. Vuelve a compilar la aplicación.".into())
}

fn search_directories() -> Vec<PathBuf> {
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    directories
        .extend(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    directories
}
fn find_node() -> Option<PathBuf> {
    search_directories()
        .into_iter()
        .map(|directory| directory.join("node"))
        .find(|candidate| {
            let Ok(metadata) = candidate.metadata() else {
                return false;
            };
            if !metadata.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}

fn write_frame(writer: &Writer, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|_| "No se pudo preparar un mensaje de Pi.".to_string())?;
    if bytes.len() > LINE_LIMIT {
        return Err("El mensaje de Pi supera el límite permitido.".into());
    }
    bytes.push(b'\n');
    let mut writer = writer
        .lock()
        .map_err(|_| "No se pudo acceder a la conexión con Pi.".to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|_| "La conexión con Pi no está disponible.".into())
}

fn read_line_bounded(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, ()> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|_| ())?;
        if buffer.is_empty() {
            return if line.is_empty() { Ok(None) } else { Err(()) };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |position| position + 1);
        if line.len() + take > LINE_LIMIT {
            return Err(());
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}
fn fail_pending(pending: &Pending, message: &str) {
    if let Ok(mut pending) = pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

#[cfg(test)]
fn selected_project(selected: &Mutex<Option<PathBuf>>) -> Result<PathBuf, String> {
    let path = selected
        .lock()
        .map_err(|_| "No se pudo acceder al proyecto autorizado.".to_string())?
        .clone()
        .ok_or("Primero selecciona un proyecto desde la aplicación.")?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "El proyecto autorizado ya no está disponible.".to_string())?;
    if canonical != path || !canonical.is_dir() {
        return Err(
            "La carpeta autorizada cambió. Vuelve a seleccionarla desde la aplicación.".into(),
        );
    }
    Ok(canonical)
}
fn dispatch_tool(tool: &str, _selected: &Mutex<Option<PathBuf>>) -> Reply {
    match tool {
        "detect_tools" => serde_json::to_value(crate::detection::detect_tools())
            .map_err(|_| "No se pudo preparar la detección local.".into()),
        "collect_inventory" => serde_json::to_value(crate::inventory::collect_inventory())
            .map_err(|_| "No se pudo preparar el inventario local.".into()),
        _ => Err("Herramienta no autorizada.".into()),
    }
}
pub fn open_auth_url(url: &str) -> Result<(), String> {
    validate_auth_url(url)?;
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("/usr/bin/open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "No se pudo abrir la página de autorización.".to_string())?;
        thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Abre manualmente el enlace de autorización en tu navegador.".into())
    }
}
fn validate_auth_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url)
        .map_err(|_| "El enlace de autorización no es válido.".to_string())?;
    let hosts = [
        "auth.openai.com",
        "auth0.openai.com",
        "claude.ai",
        "console.anthropic.com",
        "accounts.google.com",
        "github.com",
        "login.microsoftonline.com",
    ];
    if url.len() > 16384
        || parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || !parsed.host_str().is_some_and(|host| hosts.contains(&host))
    {
        return Err(
            "Solo se pueden abrir páginas HTTPS de los proveedores de autorización admitidos."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn restricts_methods_and_parameter_shape() {
        assert!(validate_request("analyze", &json!({"prompt":"revisa"})).is_ok());
        assert!(validate_request("auth_import", &json!({})).is_ok());
        assert!(validate_request("exec", &json!({"command":"anything"})).is_err());
        assert!(validate_request("analyze", &json!([])).is_err());
        assert!(validate_request("analyze", &json!({"prompt":"a".repeat(LINE_LIMIT)})).is_err());
        assert!(dispatch_tool("exec", &Mutex::new(None)).is_err());
        for removed in ["list_applications", "read_project"] {
            assert!(!TOOLS.contains(&removed));
            assert!(dispatch_tool(removed, &Mutex::new(None)).is_err());
        }
    }
    #[test]
    fn bounded_protocol_rejects_oversize_and_incomplete_lines() {
        assert_eq!(
            read_line_bounded(&mut Cursor::new(b"{\"id\":\"1\"}\n"))
                .unwrap()
                .unwrap(),
            b"{\"id\":\"1\"}\n"
        );
        assert!(read_line_bounded(&mut Cursor::new(vec![b'x'; LINE_LIMIT + 1])).is_err());
        assert!(read_line_bounded(&mut Cursor::new(b"{\"id\":\"1\"}")).is_err());
        assert!(read_line_bounded(&mut Cursor::new(b"")).unwrap().is_none());
    }
    #[test]
    fn requires_native_project_selection_and_revalidates_root() {
        assert!(selected_project(&Mutex::new(None)).is_err());
        let state = PiState::default();
        let root = std::env::temp_dir().join(format!(
            "devguard-pi-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        state.authorize_project(&root).unwrap();
        assert_eq!(
            selected_project(&state.inner.selected_project).unwrap(),
            root.canonicalize().unwrap()
        );
        fs::remove_dir(root).unwrap();
        assert!(selected_project(&state.inner.selected_project).is_err());
    }
    #[test]
    fn oauth_links_require_exact_official_https_host() {
        assert!(validate_auth_url("https://auth.openai.com/oauth/authorize?state=example").is_ok());
        assert!(validate_auth_url("https://github.com/login/oauth/authorize").is_ok());
        for url in [
            "http://auth.openai.com/",
            "https://auth.openai.com.attacker.test/",
            "https://user:pass@auth.openai.com/",
            "file:///tmp/app",
            "https://auth.openai.com:444/",
        ] {
            assert!(validate_auth_url(url).is_err());
        }
    }
    #[test]
    fn closes_pending_requests_on_exit() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (send, receive) = mpsc::channel();
        pending.lock().unwrap().insert("1".into(), send);
        fail_pending(&pending, "cerrado");
        assert!(receive.recv().unwrap().is_err());
        assert!(pending.lock().unwrap().is_empty());
    }
}
