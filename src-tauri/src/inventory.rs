//! Read-only inventories from each manager's own installed-package metadata.
//! This is deliberately not a scan of every Python environment or Node project.
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerInventory {
    pub id: &'static str,
    pub name: &'static str,
    pub status: &'static str,
    pub source: Option<String>,
    pub packages: Vec<InstalledPackage>,
    pub detail: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    pub kind: &'static str,
}

pub fn collect_inventory() -> Vec<ManagerInventory> {
    // Managers are independent; a slow Homebrew reader does not delay starting npm/pip.
    thread::scope(|scope| {
        let brew = scope.spawn(homebrew_inventory);
        let npm = scope.spawn(npm_inventory);
        let python = scope.spawn(python_inventory);
        vec![
            brew.join()
                .unwrap_or_else(|_| failed_reader("homebrew", "Homebrew")),
            npm.join()
                .unwrap_or_else(|_| failed_reader("npm", "npm global")),
            python
                .join()
                .unwrap_or_else(|_| failed_reader("python", "Python · pip")),
        ]
    })
}

fn failed_reader(id: &'static str, name: &'static str) -> ManagerInventory {
    ManagerInventory {
        id,
        name,
        status: "error",
        source: None,
        packages: vec![],
        detail: "No se pudo completar la lectura de este gestor.".into(),
    }
}

fn directories() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Applications/Xcode.app/Contents/Developer/usr/bin",
            "/Library/Developer/CommandLineTools/usr/bin",
            "/usr/bin",
            "/bin",
        ]
        .map(PathBuf::from),
    );
    paths
}

fn find_executable(binary: &str) -> Option<PathBuf> {
    directories()
        .into_iter()
        .map(|directory| directory.join(binary))
        .find(|path| {
            let Ok(resolved) = path.canonicalize() else {
                return false;
            };
            if binary == "python3"
                && (path == Path::new("/usr/bin/python3")
                    || resolved == Path::new("/usr/bin/python3"))
            {
                return false;
            }
            let Ok(metadata) = resolved.metadata() else {
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

fn initial(
    id: &'static str,
    name: &'static str,
    binary: &str,
) -> (ManagerInventory, Option<PathBuf>) {
    let executable = find_executable(binary);
    let result = ManagerInventory {
        id,
        name,
        status: if executable.is_some() {
            "ok"
        } else {
            "not_found"
        },
        source: executable
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        packages: vec![],
        detail: if executable.is_none() {
            if id == "python" {
                "No se encontró un Python ejecutable en las ubicaciones revisadas. El lanzador de macOS se omite para evitar solicitar instalaciones.".into()
            } else {
                "No se encontró el gestor en las ubicaciones revisadas; podría estar instalado en otra ubicación.".into()
            }
        } else {
            String::new()
        },
    };
    (result, executable)
}

fn homebrew_inventory() -> ManagerInventory {
    let (mut result, executable) = initial("homebrew", "Homebrew", "brew");
    let Some(executable) = executable else {
        return result;
    };
    let mut failures = Vec::new();
    for (flag, kind, label) in [
        ("--formula", "formula", "fórmulas"),
        ("--cask", "cask", "aplicaciones cask"),
    ] {
        match run(&executable, &["list", "--versions", flag], COMMAND_TIMEOUT).and_then(|output| {
            if !output.success {
                return Err(format!("El gestor no pudo enumerar {label}."));
            }
            parse_brew(&output.stdout, kind)
        }) {
            Ok(mut packages) => result.packages.append(&mut packages),
            Err(detail) => failures.push(detail),
        }
    }
    sort_packages(&mut result.packages);
    if failures.is_empty() {
        result.detail = "Fórmulas y aplicaciones cask instaladas en este Homebrew, incluidas sus dependencias. No incluye aplicaciones instaladas por otros medios.".into();
    } else {
        result.status = "error";
        result.detail = format!(
            "Inventario incompleto: {} Se conservan los paquetes que sí se pudieron leer.",
            failures.join(" ")
        );
    }
    result
}

fn npm_inventory() -> ManagerInventory {
    let (mut result, executable) = initial("npm", "npm global", "npm");
    let Some(executable) = executable else {
        return result;
    };
    match run(
        &executable,
        &["ls", "-g", "--depth=0", "--json"],
        COMMAND_TIMEOUT,
    ) {
        Ok(output) => match parse_npm(&output.stdout) {
            Ok(packages) => {
                result.packages = packages;
                result.detail = "Solo paquetes globales del npm seleccionado; no incluye dependencias de proyectos ni otras instalaciones de Node.".into();
                if !output.success {
                    result.status = "error";
                    result.detail.push_str(" npm informó problemas en su inventario; se muestran los paquetes que devolvió, sin asumir que la lista esté completa.");
                }
            }
            Err(detail) => {
                result.status = "error";
                result.detail = detail;
            }
        },
        Err(detail) => {
            result.status = "error";
            result.detail = detail;
        }
    }
    result
}

fn python_inventory() -> ManagerInventory {
    let (mut result, executable) = initial("python", "Python · pip", "python3");
    let Some(executable) = executable else {
        return result;
    };
    match run(
        &executable,
        &[
            "-B",
            "-m",
            "pip",
            "list",
            "--format=json",
            "--disable-pip-version-check",
        ],
        COMMAND_TIMEOUT,
    ) {
        Ok(output) if !output.success => {
            result.status = "error";
            result.detail = if output.stderr.contains("No module named pip") {
                "Este entorno de Python no tiene pip disponible. No se instaló ni modificó ningún paquete.".into()
            } else {
                "pip no pudo enumerar los paquetes de este Python. No se instalaron ni modificaron paquetes.".into()
            };
        }
        Ok(output) => match parse_pip(&output.stdout) {
            Ok(packages) => {
                result.packages = packages;
                result.detail = "Solo paquetes visibles para este intérprete de Python, incluido su sitio de usuario cuando corresponde. No recorre otros entornos virtuales ni instalaciones de Python.".into();
            }
            Err(detail) => {
                result.status = "error";
                result.detail = detail;
            }
        },
        Err(detail) => {
            result.status = "error";
            result.detail = detail;
        }
    }
    result
}

fn sort_packages(packages: &mut [InstalledPackage]) {
    packages.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.version.cmp(&b.version))
            .then(a.kind.cmp(b.kind))
    });
}

fn valid_field(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn package(name: &str, version: &str, kind: &'static str) -> Result<InstalledPackage, String> {
    if !valid_field(name) || !valid_field(version) {
        return Err("El gestor devolvió un nombre o versión de paquete no válido.".into());
    }
    Ok(InstalledPackage {
        name: name.into(),
        version: version.into(),
        kind,
    })
}

fn parse_brew(output: &str, kind: &'static str) -> Result<Vec<InstalledPackage>, String> {
    let mut packages = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let name = fields
            .next()
            .ok_or("Homebrew devolvió una fila no válida.")?;
        let versions: Vec<_> = fields.collect();
        if versions.is_empty() {
            return Err("Homebrew devolvió un paquete sin versión; no se presenta como un inventario completo.".into());
        }
        for version in versions {
            packages.push(package(name, version, kind)?);
        }
    }
    sort_packages(&mut packages);
    Ok(packages)
}

fn parse_npm(output: &str) -> Result<Vec<InstalledPackage>, String> {
    let root: serde_json::Value = serde_json::from_str(output)
        .map_err(|_| "npm no devolvió un inventario JSON válido.".to_string())?;
    let object = root
        .as_object()
        .ok_or("npm devolvió un formato de inventario inesperado.")?;
    let mut packages = Vec::new();
    if let Some(dependencies) = object.get("dependencies") {
        let dependencies = dependencies
            .as_object()
            .ok_or("npm devolvió una lista de paquetes no válida.")?;
        for (name, metadata) in dependencies {
            let metadata = metadata
                .as_object()
                .ok_or("npm devolvió datos de paquete no válidos.")?;
            // Linked or broken global installs may have no version. Preserve that fact explicitly.
            let version = match metadata.get("version") {
                Some(version) => version
                    .as_str()
                    .ok_or("npm devolvió una versión no válida.")?,
                None => "No disponible",
            };
            packages.push(package(name, version, "global")?);
        }
    } else if object.contains_key("error") {
        return Err("npm informó un error y no devolvió una lista de paquetes.".into());
    }
    sort_packages(&mut packages);
    Ok(packages)
}

fn parse_pip(output: &str) -> Result<Vec<InstalledPackage>, String> {
    #[derive(Deserialize)]
    struct PipPackage {
        name: String,
        version: String,
    }
    let values: Vec<PipPackage> = serde_json::from_str(output)
        .map_err(|_| "pip no devolvió un inventario JSON válido.".to_string())?;
    let mut packages = values
        .iter()
        .map(|value| package(&value.name, &value.version, "pip"))
        .collect::<Result<Vec<_>, _>>()?;
    sort_packages(&mut packages);
    Ok(packages)
}

struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

fn read_bounded(reader: impl Read + Send + 'static) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = reader.take((OUTPUT_LIMIT + 1) as u64).read_to_end(&mut bytes)
            .map_err(|_| "No se pudo leer la respuesta del gestor.".into())
            .and_then(|_| if bytes.len() > OUTPUT_LIMIT { Err("La respuesta del gestor superó el límite de lectura; el inventario no se considera completo.".into()) } else { Ok(bytes) });
        let _ = send.send(result);
    });
    receive
}

fn run(executable: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut search_paths = directories();
    if let Some(parent) = executable.parent() {
        search_paths.insert(0, parent.to_path_buf());
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir("/")
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("npm_config_offline", "true")
        .env("npm_config_ignore_scripts", "true")
        .env("npm_config_update_notifier", "false")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_logs_max", "0")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_NO_INDEX", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env_remove("PYTHONPATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(paths) = env::join_paths(search_paths) {
        command.env("PATH", paths);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "No se pudo ejecutar la lectura de este gestor.".to_string())?;
    let stdout = read_bounded(child.stdout.take().unwrap());
    let stderr = read_bounded(child.stderr.take().unwrap());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            otherwise => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if otherwise.is_err() {
                    "No se pudo comprobar la lectura del gestor."
                } else {
                    "La lectura del gestor superó el tiempo límite y se detuvo."
                }
                .into());
            }
        }
    };
    let collect = |receiver: mpsc::Receiver<Result<Vec<u8>, String>>| -> Result<String, String> {
        let bytes = receiver
            .recv_timeout(Duration::from_millis(200))
            .map_err(|_| {
                "La respuesta del gestor no se cerró dentro del tiempo permitido.".to_string()
            })??;
        String::from_utf8(bytes)
            .map_err(|_| "El gestor devolvió texto con una codificación no válida.".into())
    };
    Ok(Output {
        success: status.success(),
        stdout: collect(stdout)?,
        stderr: collect(stderr)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brew_preserves_multiple_versions_and_cask_kind() {
        let packages = parse_brew("zlib 1.3.1 1.3.2\npython@3.14 3.14.0\n", "formula").unwrap();
        assert_eq!(packages.len(), 3);
        assert_eq!(packages[0].name, "python@3.14");
        assert_eq!(packages[2].version, "1.3.2");
        assert_eq!(parse_brew("app latest\n", "cask").unwrap()[0].kind, "cask");
        assert!(parse_brew("no-version", "formula").is_err());
        assert!(parse_brew("\n", "formula").unwrap().is_empty());
    }

    #[test]
    fn npm_handles_scoped_linked_and_empty_globals_without_transitives() {
        let packages = parse_npm(r#"{"dependencies":{"@scope/tool":{"version":"2.0.0","dependencies":{"hidden":{"version":"1"}}},"linked":{"resolved":"file:/tmp/local"}}}"#).unwrap();
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0].name, "@scope/tool");
        assert_eq!(packages[1].version, "No disponible");
        assert!(parse_npm("{}").unwrap().is_empty());
        assert!(parse_npm(r#"{"error":{"code":"EFAIL"}}"#).is_err());
        assert!(parse_npm(r#"{"dependencies":[]}"#).is_err());
    }

    #[test]
    fn pip_accepts_pep_versions_but_rejects_missing_fields_and_noise() {
        let packages = parse_pip(r#"[{"name":"zope.interface","version":"7.0rc1"},{"name":"A","version":"1.0+local","editable_project_location":"/tmp/local"}]"#).unwrap();
        assert_eq!(packages[0].name, "A");
        assert_eq!(packages[1].version, "7.0rc1");
        assert!(parse_pip("[]").unwrap().is_empty());
        assert!(parse_pip(r#"[{"name":"pip"}]"#).is_err());
        assert!(parse_pip("WARNING\n[]").is_err());
    }

    #[cfg(unix)]
    fn fixture(body: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let directory = env::temp_dir().join(format!(
            "devguard-inventory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("manager");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (directory, path)
    }

    #[test]
    #[cfg(unix)]
    fn runner_keeps_nonzero_json_and_sets_offline_environment() {
        let (directory, path) = fixture(
            "[ \"$npm_config_offline\" = true ] && [ \"$PIP_NO_INDEX\" = 1 ] && [ \"$HOMEBREW_NO_AUTO_UPDATE\" = 1 ] || exit 99\nprintf '{\"dependencies\":{\"broken\":{\"version\":\"1.0.0\"}}}'\nprintf 'inventory error' >&2\nexit 1",
        );
        let output = run(&path, &["ls", "-g", "--depth=0", "--json"], COMMAND_TIMEOUT).unwrap();
        assert!(!output.success);
        assert_eq!(parse_npm(&output.stdout).unwrap().len(), 1);
        assert_eq!(output.stderr, "inventory error");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn runner_stops_hanging_reader_and_rejects_oversize_response() {
        let (directory, path) = fixture("while :; do :; done");
        let started = Instant::now();
        let error = run(&path, &[], Duration::from_millis(100)).err().unwrap();
        assert!(error.contains("tiempo"));
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::write(&path, "#!/bin/sh\n/usr/bin/head -c 2100000 /dev/zero\n").unwrap();
        assert!(run(&path, &[], COMMAND_TIMEOUT).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
