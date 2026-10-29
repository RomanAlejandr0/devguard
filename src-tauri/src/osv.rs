//! Deterministic vulnerability lookup against the public OSV database.
//!
//! The lookup is independent of how a package list was obtained: it receives
//! (ecosystem, name, version) triples, validates them, and sends only those
//! three fields to the fixed host `api.osv.dev`. No project paths, file
//! contents or identifiers are transmitted. No AI model is involved.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    thread,
    time::Duration,
};

const API: &str = "https://api.osv.dev/v1";
const TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_PACKAGES: usize = 1000;
const MAX_DETAIL_IDS: usize = 150;
const DETAIL_WORKERS: usize = 8;
const ECOSYSTEMS: [&str; 3] = ["npm", "PyPI", "crates.io"];

#[derive(Debug, Clone, Deserialize)]
pub struct PackageQuery {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vulnerability {
    pub id: String,
    pub aliases: Vec<String>,
    pub summary: Option<String>,
    /// Label published by the source database (for example GitHub's "HIGH").
    pub severity: Option<String>,
    /// Raw CVSS vector when present. DevGuard does not compute a score from it.
    pub cvss: Option<String>,
    pub fixed_in: Vec<String>,
    pub url: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageFinding {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub vulnerabilities: Vec<Vulnerability>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VulnerabilityReport {
    pub source: &'static str,
    pub checked: usize,
    pub findings: Vec<PackageFinding>,
    pub warnings: Vec<String>,
}

pub trait Transport: Sync {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String>;
    fn get(&self, path: &str) -> Result<Value, String>;
}

pub struct Http {
    agent: ureq::Agent,
}

impl Http {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(TIMEOUT)
                .redirects(0)
                .user_agent("DevGuard")
                .build(),
        }
    }
}

fn read_json(response: ureq::Response) -> Result<Value, String> {
    let mut body = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|_| "La respuesta de OSV se interrumpió.".to_string())?;
    if body.len() as u64 > RESPONSE_LIMIT {
        return Err("La respuesta de OSV superó el tamaño permitido.".into());
    }
    serde_json::from_slice(&body).map_err(|_| "OSV devolvió una respuesta no válida.".to_string())
}

impl Transport for Http {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let response = self
            .agent
            .post(&format!("{API}{path}"))
            .send_json(body.clone())
            .map_err(|_| "No se pudo consultar OSV. Revisa tu conexión.".to_string())?;
        read_json(response)
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let response = self
            .agent
            .get(&format!("{API}{path}"))
            .call()
            .map_err(|_| "No se pudo consultar OSV. Revisa tu conexión.".to_string())?;
        read_json(response)
    }
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 128
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_' | '~' | ':'))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 214
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | '/'))
}

fn validate(queries: &[PackageQuery]) -> Result<(), String> {
    if queries.len() > MAX_PACKAGES {
        return Err(format!("Se admiten hasta {MAX_PACKAGES} paquetes por consulta."));
    }
    for q in queries {
        if !ECOSYSTEMS.contains(&q.ecosystem.as_str()) || !valid_name(&q.name) || !valid_version(&q.version) {
            return Err("La lista contiene un paquete con un formato no compatible.".into());
        }
    }
    Ok(())
}

fn ids_per_query(response: &Value, expected: usize) -> Result<(Vec<Vec<String>>, bool), String> {
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .filter(|results| results.len() == expected)
        .ok_or("OSV devolvió una respuesta inesperada.")?;
    let mut truncated = false;
    let ids = results
        .iter()
        .map(|result| {
            truncated |= result.get("next_page_token").is_some();
            result
                .get("vulns")
                .and_then(Value::as_array)
                .map(|vulns| {
                    vulns
                        .iter()
                        .filter_map(|v| v.get("id").and_then(Value::as_str))
                        .filter(|id| id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':'))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    Ok((ids, truncated))
}

fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|s| s.chars().take(limit).collect::<String>())
        .filter(|s| !s.is_empty())
}

/// Returns `None` for advisories OSV marks as withdrawn.
fn parse_detail(detail: &Value, query: &PackageQuery) -> Option<Vulnerability> {
    if detail.get("withdrawn").is_some() {
        return None;
    }
    let id = text(detail.get("id"), 128)?;
    let aliases = detail
        .get("aliases")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|v| text(Some(v), 128)).take(10).collect())
        .unwrap_or_default();
    let severity = text(detail.pointer("/database_specific/severity"), 32).map(|s| s.to_uppercase());
    let cvss = detail
        .get("severity")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find_map(|s| text(s.get("score"), 200)));
    let mut fixed = BTreeSet::new();
    for affected in detail.get("affected").and_then(Value::as_array).into_iter().flatten() {
        let same_package = affected.pointer("/package/name").and_then(Value::as_str) == Some(query.name.as_str())
            && affected.pointer("/package/ecosystem").and_then(Value::as_str) == Some(query.ecosystem.as_str());
        if !same_package {
            continue;
        }
        for range in affected.get("ranges").and_then(Value::as_array).into_iter().flatten() {
            for event in range.get("events").and_then(Value::as_array).into_iter().flatten() {
                if let Some(version) = text(event.get("fixed"), 128) {
                    fixed.insert(version);
                }
            }
        }
    }
    Some(Vulnerability {
        url: format!("https://osv.dev/vulnerability/{id}"),
        id,
        aliases,
        summary: text(detail.get("summary"), 300),
        severity,
        cvss,
        fixed_in: fixed.into_iter().take(10).collect(),
    })
}

fn fetch_details(transport: &dyn Transport, ids: &[String]) -> (BTreeMap<String, Value>, usize) {
    let mut details = BTreeMap::new();
    let mut failed = 0;
    for chunk in ids.chunks(DETAIL_WORKERS) {
        let results: Vec<_> = thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|id| scope.spawn(move || (id, transport.get(&format!("/vulns/{id}")))))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        for (id, result) in results {
            match result {
                Ok(detail) => {
                    details.insert(id.clone(), detail);
                }
                Err(_) => failed += 1,
            }
        }
    }
    (details, failed)
}

pub fn check(transport: &dyn Transport, queries: Vec<PackageQuery>) -> Result<VulnerabilityReport, String> {
    validate(&queries)?;
    let mut seen = BTreeSet::new();
    let queries: Vec<_> = queries
        .into_iter()
        .filter(|q| seen.insert((q.ecosystem.clone(), q.name.clone(), q.version.clone())))
        .collect();
    let mut warnings = Vec::new();
    if queries.is_empty() {
        return Ok(VulnerabilityReport { source: "OSV", checked: 0, findings: vec![], warnings });
    }
    let body = json!({"queries": queries.iter().map(|q| json!({
        "package": {"name": q.name, "ecosystem": q.ecosystem},
        "version": q.version,
    })).collect::<Vec<_>>()});
    let (per_query, truncated) = ids_per_query(&transport.post("/querybatch", &body)?, queries.len())?;
    if truncated {
        warnings.push("OSV indicó más resultados de los devueltos para algún paquete; la lista puede estar incompleta.".into());
    }
    let mut unique: Vec<String> = per_query.iter().flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    if unique.len() > MAX_DETAIL_IDS {
        warnings.push(format!("Se encontraron {} avisos distintos; solo se detallan los primeros {MAX_DETAIL_IDS}.", unique.len()));
        unique.truncate(MAX_DETAIL_IDS);
    }
    let (details, failed) = fetch_details(transport, &unique);
    if failed > 0 {
        warnings.push(format!("No se pudo obtener el detalle de {failed} aviso(s); se omiten de la lista."));
    }
    let findings = queries
        .iter()
        .zip(per_query)
        .filter_map(|(query, ids)| {
            let vulnerabilities: Vec<_> = ids
                .iter()
                .filter_map(|id| details.get(id).and_then(|detail| parse_detail(detail, query)))
                .collect();
            (!vulnerabilities.is_empty()).then(|| PackageFinding {
                ecosystem: query.ecosystem.clone(),
                name: query.name.clone(),
                version: query.version.clone(),
                vulnerabilities,
            })
        })
        .collect();
    Ok(VulnerabilityReport { source: "OSV", checked: queries.len(), findings, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Mock {
        batch: Value,
        details: BTreeMap<String, Value>,
        posted: Mutex<Vec<Value>>,
    }
    impl Transport for Mock {
        fn post(&self, _path: &str, body: &Value) -> Result<Value, String> {
            self.posted.lock().unwrap().push(body.clone());
            Ok(self.batch.clone())
        }
        fn get(&self, path: &str) -> Result<Value, String> {
            self.details.get(path.trim_start_matches("/vulns/")).cloned().ok_or_else(|| "missing".into())
        }
    }
    fn q(name: &str, version: &str) -> PackageQuery {
        PackageQuery { ecosystem: "npm".into(), name: name.into(), version: version.into() }
    }
    fn advisory(id: &str) -> Value {
        json!({"id": id, "aliases": ["CVE-2021-0001"], "summary": "Prototype pollution",
            "database_specific": {"severity": "high"},
            "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
            "affected": [
                {"package": {"name": "lodash", "ecosystem": "npm"}, "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]},
                {"package": {"name": "other", "ecosystem": "npm"}, "ranges": [{"events": [{"fixed": "9.9.9"}]}]}
            ]})
    }

    #[test]
    fn rejects_unsupported_ecosystems_and_malformed_fields_before_any_request() {
        let mock = Mock { batch: json!({}), details: BTreeMap::new(), posted: Mutex::new(vec![]) };
        for bad in [
            PackageQuery { ecosystem: "evil".into(), name: "a".into(), version: "1.0.0".into() },
            q("a b", "1.0.0"),
            q("a", "1.0.0\n"),
            q("", "1.0.0"),
            q("a", ""),
        ] {
            assert!(check(&mock, vec![bad]).is_err());
        }
        assert!(mock.posted.lock().unwrap().is_empty());
    }

    #[test]
    fn sends_only_package_fields_and_deduplicates() {
        let mock = Mock {
            batch: json!({"results": [{}]}),
            details: BTreeMap::new(),
            posted: Mutex::new(vec![]),
        };
        let report = check(&mock, vec![q("lodash", "4.17.20"), q("lodash", "4.17.20")]).unwrap();
        assert_eq!(report.checked, 1);
        assert!(report.findings.is_empty());
        assert_eq!(
            mock.posted.lock().unwrap()[0],
            json!({"queries": [{"package": {"name": "lodash", "ecosystem": "npm"}, "version": "4.17.20"}]})
        );
    }

    #[test]
    fn maps_advisories_to_the_affected_package_and_keeps_clean_packages_out() {
        let mock = Mock {
            batch: json!({"results": [{"vulns": [{"id": "GHSA-35jh-r3h4-6jhm"}]}, {}]}),
            details: BTreeMap::from([("GHSA-35jh-r3h4-6jhm".into(), advisory("GHSA-35jh-r3h4-6jhm"))]),
            posted: Mutex::new(vec![]),
        };
        let report = check(&mock, vec![q("lodash", "4.17.20"), q("react", "19.1.0")]).unwrap();
        assert_eq!(report.checked, 2);
        assert_eq!(report.findings.len(), 1);
        let v = &report.findings[0].vulnerabilities[0];
        assert_eq!(report.findings[0].name, "lodash");
        assert_eq!(v.severity.as_deref(), Some("HIGH"));
        assert_eq!(v.fixed_in, vec!["4.17.21"]);
        assert_eq!(v.url, "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm");
        assert!(v.cvss.as_deref().unwrap().starts_with("CVSS:3.1"));
    }

    #[test]
    fn skips_withdrawn_advisories_and_reports_failed_details() {
        let mut withdrawn = advisory("GHSA-aaaa");
        withdrawn["withdrawn"] = json!("2024-01-01T00:00:00Z");
        let mock = Mock {
            batch: json!({"results": [{"vulns": [{"id": "GHSA-aaaa"}, {"id": "GHSA-bbbb"}]}]}),
            details: BTreeMap::from([("GHSA-aaaa".into(), withdrawn)]),
            posted: Mutex::new(vec![]),
        };
        let report = check(&mock, vec![q("lodash", "4.17.20")]).unwrap();
        assert!(report.findings.is_empty());
        assert!(report.warnings.iter().any(|w| w.contains("1 aviso")));
    }

    #[test]
    fn rejects_responses_that_do_not_match_the_request() {
        let mock = Mock { batch: json!({"results": []}), details: BTreeMap::new(), posted: Mutex::new(vec![]) };
        assert!(check(&mock, vec![q("lodash", "4.17.20")]).is_err());
    }

    #[test]
    fn flags_possibly_incomplete_pages() {
        let mock = Mock {
            batch: json!({"results": [{"vulns": [], "next_page_token": "x"}]}),
            details: BTreeMap::new(),
            posted: Mutex::new(vec![]),
        };
        let report = check(&mock, vec![q("lodash", "4.17.20")]).unwrap();
        assert!(report.warnings.iter().any(|w| w.contains("incompleta")));
    }
}
