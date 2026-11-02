// OSV is evidence for the agent, never a model's recollection of vulnerabilities.
export async function osvLookup(packages, { fetcher = fetch, signal } = {}) {
  const exact = packages.filter(
    (p) =>
      p.version &&
      [
        "npm",
        "PyPI",
        "crates.io",
        "Go",
        "Maven",
        "Packagist",
        "RubyGems",
        "NuGet",
      ].includes(p.ecosystem),
  );
  const warnings = [];
  const findings = [];
  if (exact.length !== packages.length)
    warnings.push(
      "Hay paquetes sin versión exacta o con ecosistema no admitido por esta consulta.",
    );
  async function request(path, body) {
    const response = await fetcher("https://api.osv.dev/v1" + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("OSV no respondió correctamente");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 4 * 1024 * 1024)
          throw Error("Respuesta OSV demasiado grande");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const cache = new Map();
  let checked = 0;
  for (let offset = 0; offset < exact.length; offset += 100) {
    signal?.throwIfAborted();
    const batch = exact.slice(offset, offset + 100);
    let data;
    try {
      data = await request("/querybatch", {
        queries: batch.map((p) => ({
          package: { ecosystem: p.ecosystem, name: p.name },
          version: p.version,
        })),
      });
      if (!Array.isArray(data.results) || data.results.length !== batch.length)
        throw Error("Respuesta incompleta");
    } catch {
      signal?.throwIfAborted();
      warnings.push("No se pudo consultar OSV para un grupo de paquetes.");
      continue;
    }
    checked += batch.length;
    for (let i = 0; i < batch.length; i++) {
      const entry = data.results[i];
      if (
        !entry ||
        typeof entry !== "object" ||
        (entry.vulns && !Array.isArray(entry.vulns))
      ) {
        warnings.push("OSV devolvió un resultado inválido.");
        continue;
      }
      if (entry.next_page_token)
        warnings.push("OSV tiene páginas adicionales: resultados incompletos.");
      for (const v of entry.vulns ?? []) {
        if (typeof v.id !== "string" || !/^[\w:-]{1,128}$/.test(v.id)) {
          warnings.push("OSV devolvió un identificador inválido.");
          continue;
        }
        let detail = cache.get(v.id);
        if (!cache.has(v.id) && cache.size < 100) {
          try {
            detail = await request("/vulns/" + encodeURIComponent(v.id));
          } catch {
            signal?.throwIfAborted();
            detail = null;
          }
          cache.set(v.id, detail);
        }
        if (detail?.withdrawn) continue;
        if (!detail)
          warnings.push(
            "Hay avisos de OSV sin detalle; se conservan sus identificadores.",
          );
        findings.push({
          ecosystem: batch[i].ecosystem,
          name: batch[i].name,
          version: batch[i].version,
          id: v.id,
          url: "https://osv.dev/vulnerability/" + encodeURIComponent(v.id),
          summary:
            typeof detail?.summary === "string"
              ? detail.summary.slice(0, 400)
              : "Aviso publicado en OSV; detalle no disponible.",
          severity:
            typeof detail?.database_specific?.severity === "string"
              ? detail.database_specific.severity.slice(0, 32)
              : null,
        });
      }
    }
  }
  return { source: "OSV", checked, findings, warnings: [...new Set(warnings)] };
}
