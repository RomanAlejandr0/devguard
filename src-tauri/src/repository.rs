//! Bounded, read-only snapshot. Repository text is data, never executable instructions.
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path};
const MAX_FILES: usize = 300;
const MAX_BYTES: usize = 512 * 1024;
const FILE_BYTES: u64 = 128 * 1024;
const SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "vendor",
    ".next",
    "__pycache__",
    ".idea",
    ".DS_Store",
];
fn secret(name: &str) -> bool {
    let name = name.to_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name == "auth.json"
        || name == ".npmrc"
        || name == ".pypirc"
        || name == ".netrc"
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
}
pub fn snapshot(root: &Path) -> Result<Value, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "La carpeta ya no está disponible.")?;
    if !root.is_dir() {
        return Err("Selecciona una carpeta de repositorio.".into());
    }
    let mut files = vec![];
    let mut omitted = 0usize;
    let mut total = 0usize;
    let mut visited = 0usize;
    let mut pending = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        if depth > 20 || visited > 10000 {
            omitted += 1;
            continue;
        }
        let mut entries = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            visited += 1;
            if visited > 10000 {
                omitted += 1;
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            if secret(&name) {
                omitted += 1;
                continue;
            }
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    omitted += 1;
                    continue;
                }
            };
            if meta.is_symlink() {
                omitted += 1;
                continue;
            }
            if meta.is_dir() {
                pending.push((path, depth + 1));
                continue;
            }
            if !meta.is_file()
                || meta.len() > FILE_BYTES
                || total + meta.len() as usize > MAX_BYTES
                || files.len() >= MAX_FILES
            {
                omitted += 1;
                continue;
            }
            // Canonical containment check plus O_NOFOLLOW prevents leaf symlink swaps.
            if !path
                .canonicalize()
                .map(|p| p.starts_with(&root))
                .unwrap_or(false)
            {
                omitted += 1;
                continue;
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let file = match options.open(&path) {
                Ok(f) => f,
                Err(_) => {
                    omitted += 1;
                    continue;
                }
            };
            if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
                omitted += 1;
                continue;
            }
            let mut bytes = vec![];
            if file.take(FILE_BYTES + 1).read_to_end(&mut bytes).is_err()
                || bytes.len() as u64 > FILE_BYTES
                || bytes.contains(&0)
            {
                omitted += 1;
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                omitted += 1;
                continue;
            };
            total += text.len();
            files.push(
                json!({"path":path.strip_prefix(&root).unwrap().to_string_lossy(),"text":text}),
            );
        }
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let result = json!({"path":root.to_string_lossy(),"name":root.file_name().unwrap_or_default().to_string_lossy(),"files":files,"omitted":omitted,"limits":{"files":MAX_FILES,"fileBytes":FILE_BYTES,"totalBytes":MAX_BYTES}});
    if serde_json::to_vec(&result)
        .map_err(|_| "No se pudo preparar la lectura.")?
        .len()
        > 1500000
    {
        return Err("El repositorio supera el límite de lectura de esta versión.".into());
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_secrets_links_and_builds_and_reports_coverage() {
        let dir = std::env::temp_dir().join(format!("devguard-repository-{}", std::process::id()));
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("README.md"), "normal project").unwrap();
        fs::write(dir.join(".env"), "DO_NOT_SEND=secret").unwrap();
        fs::write(dir.join("node_modules/x.js"), "dependency").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", dir.join("outside")).unwrap();
        let s = snapshot(&dir).unwrap();
        assert_eq!(s["files"].as_array().unwrap().len(), 1);
        assert!(s["omitted"].as_u64().unwrap() > 0);
        assert!(!s.to_string().contains("DO_NOT_SEND"));
        fs::remove_dir_all(dir).unwrap();
    }
}
