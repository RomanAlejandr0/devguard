use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Read, path::Path};

const MANIFEST_LIMIT: u64 = 1024 * 1024;
const LOCK_LIMIT: u64 = 8 * 1024 * 1024;
const GROUPS: [(&str, &str); 4] = [
    ("dependencies", "production"),
    ("devDependencies", "development"),
    ("optionalDependencies", "optional"),
    ("peerDependencies", "peer"),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReport {
    pub name: String,
    pub path: String,
    pub lockfile: Option<String>,
    pub warnings: Vec<String>,
    pub dependencies: Vec<ProjectDependency>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDependency {
    pub name: String,
    pub kind: &'static str,
    pub declared: String,
    pub resolved: Option<String>,
}

// Only these two fixed filenames are read, and only inside the selected root.
// Symlinks and special files are rejected before opening; reads are capped even
// if a regular file grows after its metadata was checked.
fn read_json(root: &Path, filename: &str, limit: u64) -> Result<Option<Value>, ()> {
    let path = root.join(filename);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err(());
    }
    let canonical = path.canonicalize().map_err(|_| ())?;
    if canonical.parent() != Some(root) {
        return Err(());
    }
    let file = fs::File::open(canonical).map_err(|_| ())?;
    let mut contents = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut contents)
        .map_err(|_| ())?;
    if contents.len() as u64 > limit {
        return Err(());
    }
    serde_json::from_slice(&contents).map(Some).map_err(|_| ())
}

pub fn read_project(selected: &Path) -> Result<ProjectReport, String> {
    let root = selected
        .canonicalize()
        .map_err(|_| "No se pudo acceder a la carpeta seleccionada.".to_string())?;
    if !root.is_dir() {
        return Err("Selecciona la carpeta raíz de un proyecto de Node.".into());
    }
    let manifest = read_json(&root, "package.json", MANIFEST_LIMIT)
        .map_err(|_| "No se pudo leer package.json. Debe ser un archivo JSON válido, regular y de hasta 1 MB.".to_string())?
        .ok_or_else(|| "Esta carpeta no contiene package.json. Selecciona la raíz de un proyecto de Node.".to_string())?;
    if !manifest.is_object() {
        return Err("package.json debe contener un objeto JSON válido.".into());
    }
    let mut dependencies = Vec::new();
    for (group, kind) in GROUPS {
        let Some(value) = manifest.get(group) else {
            continue;
        };
        let object = value.as_object().ok_or_else(|| {
            "Las listas de dependencias de package.json no tienen el formato esperado.".to_string()
        })?;
        for (name, specification) in object {
            let declared = specification.as_str().ok_or_else(|| {
                "Las versiones declaradas en package.json deben ser texto.".to_string()
            })?;
            if name.is_empty() || name.len() > 214 || declared.len() > 4096 {
                return Err(
                    "package.json contiene una dependencia con formato no compatible.".into(),
                );
            }
            dependencies.push(ProjectDependency {
                name: name.clone(),
                kind,
                declared: declared.to_string(),
                resolved: None,
            });
        }
    }
    dependencies.sort_by(|a, b| a.name.cmp(&b.name).then(a.kind.cmp(b.kind)));
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let mut report = ProjectReport {
        name,
        path: root.to_string_lossy().into_owned(),
        lockfile: None,
        warnings: Vec::new(),
        dependencies,
    };
    if manifest.get("workspaces").is_some() {
        report.warnings.push("Este proyecto declara workspaces. Solo se revisan las dependencias de package.json en la raíz; no se recorren los subproyectos.".into());
    }
    match read_json(&root, "package-lock.json", LOCK_LIMIT) {
        Ok(Some(lock)) => {
            report.lockfile = Some("package-lock.json".into());
            resolve_from_lock(&manifest, &lock, &mut report);
        }
        Ok(None) => report.warnings.push("No hay package-lock.json. Se muestran las versiones declaradas, sin una versión resuelta.".into()),
        Err(()) => {
            report.lockfile = Some("package-lock.json".into());
            report.warnings.push("No se pudo leer package-lock.json como JSON regular de hasta 8 MB. Se muestran solo las versiones declaradas.".into());
        }
    }
    Ok(report)
}

fn resolve_from_lock(manifest: &Value, lock: &Value, report: &mut ProjectReport) {
    let version = lock.get("lockfileVersion").and_then(Value::as_u64);
    if !matches!(version, Some(2 | 3)) {
        report.warnings.push("Esta versión de package-lock.json no está soportada. Se admiten las versiones 2 y 3; se muestran solo las declaraciones.".into());
        return;
    }
    let Some(packages) = lock.get("packages").and_then(Value::as_object) else {
        report.warnings.push("package-lock.json no contiene una lista de paquetes válida. Se muestran solo las versiones declaradas.".into());
        return;
    };
    let Some(root) = packages.get("").filter(|value| value.is_object()) else {
        report.warnings.push("package-lock.json no contiene los datos de la raíz del proyecto. Se muestran solo las versiones declaradas.".into());
        return;
    };
    let mut stale = false;
    let mut unresolved = false;
    for dependency in &mut report.dependencies {
        let group = GROUPS
            .iter()
            .find(|(_, kind)| *kind == dependency.kind)
            .unwrap()
            .0;
        let from_manifest = manifest
            .get(group)
            .and_then(|value| value.get(&dependency.name));
        let from_lock = root
            .get(group)
            .and_then(|value| value.get(&dependency.name));
        if from_manifest != from_lock {
            stale = true;
            continue;
        }
        // Workspace/local/git aliases have different resolution semantics. Do
        // not present a registry version as though it represented those specs.
        if [
            "file:",
            "link:",
            "workspace:",
            "npm:",
            "git:",
            "git+",
            "http:",
            "https:",
        ]
        .iter()
        .any(|prefix| dependency.declared.starts_with(prefix))
            || dependency.declared.contains('/')
        {
            unresolved = true;
            continue;
        }
        let entry = packages.get(&format!("node_modules/{}", dependency.name));
        let Some(entry) =
            entry.filter(|entry| entry.get("link").and_then(Value::as_bool) != Some(true))
        else {
            unresolved = true;
            continue;
        };
        let Some(version) = entry
            .get("version")
            .and_then(Value::as_str)
            .filter(|version| is_package_version(version))
        else {
            unresolved = true;
            continue;
        };
        dependency.resolved = Some(version.to_string());
    }
    if stale {
        report.warnings.push("Hay declaraciones que no coinciden con package-lock.json. Su versión resuelta se omite para evitar mostrar datos desactualizados.".into());
    }
    if unresolved {
        report.warnings.push("Algunas dependencias no tienen una versión resuelta compatible en el archivo de bloqueo. Se conserva su declaración.".into());
    }
}

fn is_package_version(value: &str) -> bool {
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(manifest: &str, lock: Option<&str>) -> Self {
            let root = std::env::temp_dir().join(format!(
                "devguard-project-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("package.json"), manifest).unwrap();
            if let Some(lock) = lock {
                fs::write(root.join("package-lock.json"), lock).unwrap();
            }
            Self(root)
        }
        fn report(&self) -> Result<ProjectReport, String> {
            read_project(&self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_direct_and_scoped_packages_with_v2_and_v3() {
        let manifest = json!({"name":"fixture", "dependencies":{"@scope/pkg":"^1.0.0"}, "devDependencies":{"test":"~2.1.0"}});
        for version in [2, 3] {
            let lock = json!({"lockfileVersion":version,"packages":{"":manifest,"node_modules/@scope/pkg":{"version":"1.2.3"},"node_modules/test":{"version":"2.1.4"},"node_modules/transitive":{"version":"9.0.0"}}});
            let fixture = Fixture::new(&manifest.to_string(), Some(&lock.to_string()));
            let report = fixture.report().unwrap();
            assert_eq!(report.dependencies.len(), 2);
            assert_eq!(report.dependencies[0].resolved.as_deref(), Some("1.2.3"));
            assert_eq!(report.dependencies[1].resolved.as_deref(), Some("2.1.4"));
            assert!(report.warnings.is_empty());
        }
    }

    #[test]
    fn missing_or_broken_lock_preserves_declarations() {
        for lock in [None, Some("{broken")] {
            let fixture = Fixture::new(r#"{"dependencies":{"example":"^1.0.0"}}"#, lock);
            let report = fixture.report().unwrap();
            assert_eq!(report.dependencies[0].declared, "^1.0.0");
            assert!(report.dependencies[0].resolved.is_none());
            assert_eq!(report.warnings.len(), 1);
        }
    }

    #[test]
    fn stale_lock_never_reports_outdated_resolution() {
        let fixture = Fixture::new(
            r#"{"dependencies":{"example":"^2.0.0"}}"#,
            Some(
                r#"{"lockfileVersion":3,"packages":{"":{"dependencies":{"example":"^1.0.0"}},"node_modules/example":{"version":"1.4.0"}}}"#,
            ),
        );
        let report = fixture.report().unwrap();
        assert!(report.dependencies[0].resolved.is_none());
        assert!(report.warnings[0].contains("no coinciden"));
    }

    #[test]
    fn preserves_multiple_kinds_and_does_not_treat_links_or_aliases_as_versions() {
        let manifest = json!({"dependencies":{"shared":"1.0.0","alias":"npm:real@1.0.0","local":"file:../local"},"optionalDependencies":{"shared":"1.0.0"},"peerDependencies":{"peer":"^2.0.0"}});
        let lock = json!({"lockfileVersion":3,"packages":{"":manifest,"node_modules/shared":{"version":"1.0.0"},"node_modules/alias":{"version":"1.0.0"},"node_modules/local":{"link":true,"version":"1.0.0"},"node_modules/peer":{"version":"2.3.0"}}});
        let fixture = Fixture::new(&manifest.to_string(), Some(&lock.to_string()));
        let report = fixture.report().unwrap();
        assert_eq!(report.dependencies.len(), 5);
        assert_eq!(
            report
                .dependencies
                .iter()
                .filter(|dep| dep.name == "shared")
                .count(),
            2
        );
        assert!(
            report
                .dependencies
                .iter()
                .filter(|dep| matches!(dep.name.as_str(), "alias" | "local"))
                .all(|dep| dep.resolved.is_none())
        );
        assert!(
            report
                .dependencies
                .iter()
                .any(|dep| dep.kind == "peer" && dep.resolved.as_deref() == Some("2.3.0"))
        );
    }

    #[test]
    fn invalid_manifest_is_actionable_and_does_not_echo_file_contents() {
        for manifest in [
            "secret invalid content",
            "[]",
            r#"{"dependencies":{"example":12}}"#,
        ] {
            let fixture = Fixture::new(manifest, None);
            let error = fixture.report().unwrap_err();
            assert!(!error.contains("secret"));
            assert!(error.contains("package.json"));
        }
        let fixture = Fixture::new("{}", None);
        fs::remove_file(fixture.0.join("package.json")).unwrap();
        assert!(
            fixture
                .report()
                .unwrap_err()
                .contains("no contiene package.json")
        );
    }

    #[test]
    fn rejects_oversized_files_without_reading_them_as_json() {
        let fixture = Fixture::new("{}", None);
        fs::File::create(fixture.0.join("package.json"))
            .unwrap()
            .set_len(MANIFEST_LIMIT + 1)
            .unwrap();
        assert!(fixture.report().unwrap_err().contains("1 MB"));
        fs::write(fixture.0.join("package.json"), "{}").unwrap();
        fs::File::create(fixture.0.join("package-lock.json"))
            .unwrap()
            .set_len(LOCK_LIMIT + 1)
            .unwrap();
        assert!(fixture.report().unwrap().warnings[0].contains("8 MB"));
    }

    #[test]
    #[cfg(unix)]
    fn does_not_follow_symlinked_manifests_or_lockfiles() {
        use std::os::unix::fs::symlink;
        let source = Fixture::new("{}", Some("{}"));
        let fixture = Fixture::new("{}", None);
        fs::remove_file(fixture.0.join("package.json")).unwrap();
        symlink(
            source.0.join("package.json"),
            fixture.0.join("package.json"),
        )
        .unwrap();
        assert!(fixture.report().is_err());
        fs::remove_file(fixture.0.join("package.json")).unwrap();
        fs::write(fixture.0.join("package.json"), "{}").unwrap();
        symlink(
            source.0.join("package-lock.json"),
            fixture.0.join("package-lock.json"),
        )
        .unwrap();
        assert!(fixture.report().unwrap().warnings[0].contains("No se pudo leer"));
    }
}
