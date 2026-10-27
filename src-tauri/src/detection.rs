use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(4);
const OUTPUT_LIMIT: usize = 16 * 1024;

#[derive(Debug, Serialize)]
pub struct ToolDetection {
    id: &'static str,
    name: &'static str,
    status: &'static str,
    version: Option<String>,
    path: Option<String>,
    detail: String,
}

#[derive(Clone, Copy)]
struct Tool {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    prefix: &'static str,
}

const TOOLS: [Tool; 3] = [
    Tool {
        id: "node",
        name: "Node.js",
        binary: "node",
        prefix: "v",
    },
    Tool {
        id: "python",
        name: "Python",
        binary: "python3",
        prefix: "Python ",
    },
    Tool {
        id: "homebrew",
        name: "Homebrew",
        binary: "brew",
        prefix: "Homebrew ",
    },
];

pub fn detect_tools() -> Vec<ToolDetection> {
    let mut directories: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    directories.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Applications/Xcode.app/Contents/Developer/usr/bin",
            "/Library/Developer/CommandLineTools/usr/bin",
            "/usr/bin",
        ]
        .map(PathBuf::from),
    );
    TOOLS
        .iter()
        .map(|tool| detect(*tool, &directories))
        .collect()
}

fn detect(tool: Tool, directories: &[PathBuf]) -> ToolDetection {
    let mut result = ToolDetection {
        id: tool.id,
        name: tool.name,
        status: "not_found",
        version: None,
        path: None,
        detail:
            "No se encontró en las ubicaciones revisadas. Puede estar instalada en otra ubicación."
                .into(),
    };
    let mut seen = HashSet::new();
    for directory in directories {
        let candidate = directory.join(tool.binary);
        let Ok(resolved) = candidate.canonicalize() else {
            continue;
        };
        if !seen.insert(resolved.clone()) || !is_executable(&resolved) {
            continue;
        }
        // Apple's launcher may open a developer-tools installation dialog. Never run it.
        if tool.id == "python"
            && (candidate == Path::new("/usr/bin/python3")
                || resolved == Path::new("/usr/bin/python3"))
        {
            result.detail = "Solo se encontró el lanzador de Python de macOS. No se ejecutó para evitar solicitar la instalación de herramientas de desarrollo.".into();
            continue;
        }
        result.path = Some(candidate.to_string_lossy().into_owned());
        match run_version(&candidate, TIMEOUT) {
            Ok(output) => match parse_version(tool, &output) {
                Some(version) => {
                    result.status = "found";
                    result.version = Some(version);
                    result.detail = "Versión consultada localmente. No se evaluó su seguridad ni si está actualizada.".into();
                }
                None => {
                    result.status = "error";
                    result.detail =
                        "El ejecutable respondió, pero no se pudo reconocer su versión.".into();
                }
            },
            Err(detail) => {
                result.status = "error";
                result.detail = detail;
            }
        }
        return result;
    }
    result
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
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
}

fn read_bounded(reader: impl Read + Send + 'static) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = reader
            .take((OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    receiver
}

fn run_version(path: &Path, timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(path)
        .arg("--version")
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "No se pudo ejecutar la consulta de versión.".to_string())?;
    let stdout = read_bounded(child.stdout.take().unwrap());
    let stderr = read_bounded(child.stderr.take().unwrap());
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("La consulta superó el tiempo límite y se detuvo.".into());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("No se pudo comprobar el resultado de la consulta.".into());
            }
        }
    };
    if !status.success() {
        return Err("La herramienta devolvió un error al consultar su versión.".into());
    }
    let collect = |receiver: mpsc::Receiver<std::io::Result<Vec<u8>>>| -> Result<Vec<u8>, String> {
        let bytes = receiver
            .recv_timeout(Duration::from_millis(200))
            .map_err(|_| "No se pudo leer la respuesta completa de la herramienta.".to_string())?
            .map_err(|_| "No se pudo leer la respuesta de la herramienta.".to_string())?;
        if bytes.len() > OUTPUT_LIMIT {
            return Err("La respuesta de la herramienta superó el límite permitido.".into());
        }
        Ok(bytes)
    };
    let out = collect(stdout)?;
    let err = collect(stderr)?;
    let bytes = if out.is_empty() { err } else { out };
    String::from_utf8(bytes)
        .map_err(|_| "La respuesta de la herramienta no es texto válido.".into())
}

fn parse_version(tool: Tool, output: &str) -> Option<String> {
    let line = output
        .lines()
        .find(|line| line.trim().starts_with(tool.prefix))?
        .trim();
    let value = line.strip_prefix(tool.prefix)?.split_whitespace().next()?;
    let core = value.split(['-', '+']).next()?;
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() < 2
        || !parts.iter().enumerate().all(|(index, part)| {
            !part.is_empty()
                && if index == parts.len() - 1 {
                    part.as_bytes()[0].is_ascii_digit()
                        && part.bytes().all(|c| c.is_ascii_alphanumeric())
                } else {
                    part.bytes().all(|c| c.is_ascii_digit())
                }
        })
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
    {
        return None;
    }
    Some(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_version_formats_and_rejects_noise() {
        assert_eq!(
            parse_version(TOOLS[0], "v24.18.0\n"),
            Some("24.18.0".into())
        );
        assert_eq!(
            parse_version(TOOLS[1], "Python 3.14.0rc1\n"),
            Some("3.14.0rc1".into())
        );
        assert_eq!(
            parse_version(TOOLS[1], "Python 3.13.7\n"),
            Some("3.13.7".into())
        );
        assert_eq!(
            parse_version(TOOLS[2], "Homebrew 4.6.16\nHomebrew/homebrew-core"),
            Some("4.6.16".into())
        );
        assert_eq!(parse_version(TOOLS[0], "version unknown"), None);
        assert_eq!(parse_version(TOOLS[0], "vnot-a-version"), None);
    }

    #[test]
    fn missing_tool_is_not_a_security_diagnosis() {
        let result = detect(TOOLS[0], &[PathBuf::from("/devguard-nonexistent")]);
        assert_eq!(result.status, "not_found");
        assert!(result.version.is_none());
        assert!(result.path.is_none());
    }

    #[cfg(unix)]
    fn fixture(body: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let directory = env::temp_dir().join(format!(
            "devguard-detector-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("node");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (directory, path)
    }

    #[test]
    #[cfg(unix)]
    fn executes_fixed_argument_and_reports_failures() {
        let (directory, path) =
            fixture("[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\nprintf 'v22.1.0\\n'");
        let result = detect(TOOLS[0], std::slice::from_ref(&directory));
        assert_eq!(result.status, "found");
        assert_eq!(result.version.as_deref(), Some("22.1.0"));
        std::fs::write(&path, "#!/bin/sh\nexit 2\n").unwrap();
        assert!(run_version(&path, TIMEOUT).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn stops_hanging_process_and_bounds_output() {
        let (directory, path) = fixture("while :; do :; done");
        let started = Instant::now();
        assert!(
            run_version(&path, Duration::from_millis(100))
                .unwrap_err()
                .contains("tiempo")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::write(&path, "#!/bin/sh\n/usr/bin/head -c 20000 /dev/zero\n").unwrap();
        assert!(run_version(&path, TIMEOUT).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
