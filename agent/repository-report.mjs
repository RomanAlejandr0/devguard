import { createHash } from "node:crypto";
export const repositoryId = (path) =>
  createHash("sha256").update(path).digest("hex").slice(0, 24);
const text = (v, max = 1000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw Error("Texto inválido");
  return v;
};
export function evidence(item, files, read) {
  const path = text(item.path, 500),
    excerpt = text(item.excerpt, 800);
  if (!read.has(path) || !files.get(path)?.includes(excerpt))
    throw Error(
      "La evidencia debe ser un fragmento literal de un archivo leído",
    );
  return {
    path,
    excerpt,
    line: files.get(path).slice(0, files.get(path).indexOf(excerpt)).split("\n")
      .length,
  };
}
export function validateProject(value, files, read) {
  if (!Array.isArray(value.evidence) || !value.evidence.length)
    throw Error("Falta evidencia de arquitectura");
  return {
    type: text(value.type, 200),
    architecture: text(value.architecture, 2000),
    evidence: value.evidence.slice(0, 12).map((e) => evidence(e, files, read)),
  };
}
export function validatePackages(value, files, read) {
  if (!Array.isArray(value.packages) || value.packages.length > 1000)
    throw Error("Lista de paquetes inválida");
  const seen = new Set();
  return value.packages.map((p) => {
    const ev = evidence(p, files, read);
    const name = text(p.name, 214),
      ecosystem = text(p.ecosystem, 80),
      declared = text(p.declared, 200);
    if (!ev.excerpt.toLowerCase().includes(name.toLowerCase()))
      throw Error("Falta el nombre literal del paquete en la evidencia");
    const version = p.version === null ? null : text(p.version, 128);
    if (
      version &&
      (!/^v?[0-9][A-Za-z0-9.!+_:-]*$/.test(version) ||
        !ev.excerpt.includes(version))
    )
      throw Error(
        "La versión exacta necesita evidencia literal; usa null para rangos",
      );
    const key = ecosystem + ":" + name + "@" + version + ":" + ev.path;
    if (seen.has(key)) throw Error("Paquete duplicado");
    seen.add(key);
    return {
      name,
      ecosystem,
      declared,
      version,
      kind: text(p.kind, 40),
      ...ev,
    };
  });
}
export function validatePrompts(value, files, read) {
  if (!Array.isArray(value.findings) || value.findings.length > 100)
    throw Error("Hallazgos inválidos");
  return value.findings.map((f) => {
    if (!["high", "medium"].includes(f.confidence))
      throw Error("Confianza inválida");
    return {
      ...evidence(f, files, read),
      reason: text(f.reason, 1500),
      confidence: f.confidence,
    };
  });
}
export function reportStatus(report) {
  if (
    report.vulnerabilities?.findings.length ||
    report.prompts?.some((f) => f.confidence === "high")
  )
    return "red";
  if (
    report.state !== "completed" ||
    report.prompts?.length ||
    report.limitations.length
  )
    return "orange";
  return "green";
}
