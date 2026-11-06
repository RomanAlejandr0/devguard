import { Card, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SkillInstructions from "./SkillInstructions";
import "./RepositoryDashboard.css";
type Evidence = { path: string; excerpt: string; line: number };
type Package = Evidence & {
  name: string;
  ecosystem: string;
  declared: string;
  version: string | null;
  kind: string;
};
type Advisory = {
  name: string;
  version: string;
  id: string;
  url: string;
  summary: string;
  severity: string | null;
};
export type RepositoryReport = {
  id: string;
  name: string;
  path: string;
  state: string;
  status: "green" | "orange" | "red";
  stage: string;
  startedAt: string;
  completedAt: string | null;
  provider: string | null;
  model: string | null;
  project: { type: string; architecture: string; evidence: Evidence[] } | null;
  packages: Package[];
  vulnerabilities: {
    source: string;
    checked: number;
    findings: Advisory[];
    warnings: string[];
  } | null;
  prompts: (Evidence & { confidence: string; reason: string })[];
  limitations: string[];
  coverage: { available: number; read: number; omitted: number };
};
const request = <T,>(method: string, params = {}) =>
  invoke<T>("pi_request", { method, params });
const statusLabel = (r: RepositoryReport) =>
  r.state === "running"
    ? "Análisis en curso"
    : r.state === "cancelled"
      ? "Cancelado"
      : r.state === "error"
        ? "No se completó"
        : r.state === "interrupted"
          ? "Interrumpido"
          : r.status === "red"
            ? "Riesgos detectados"
            : r.status === "orange"
              ? "Requiere revisión"
              : "Sin hallazgos en lo revisado";
export default function RepositoryDashboard({
  onSettings,
}: {
  onSettings: () => void;
}) {
  const [reports, setReports] = useState<RepositoryReport[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const active = useRef(false),
    alive = useRef(false),
    cancelling = useRef(false);
  const report = reports.find((r) => r.id === selected);
  useEffect(() => {
    alive.current = true;
    if (!isTauri()) {
      setLoading(false);
      return () => {
        alive.current = false;
      };
    }
    let dispose: (() => void) | undefined;
    void listen<{ event: string; data: { message?: string } }>(
      "pi-event",
      ({ payload }) => {
        if (active.current && payload.event === "progress")
          setProgress(payload.data.message ?? "");
      },
    ).then((fn) => {
      if (alive.current) dispose = fn;
      else fn();
    });
    void request<RepositoryReport[]>("repository_list")
      .then((items) => {
        if (alive.current) setReports(items);
      })
      .catch(() => {
        if (alive.current)
          setError("No se pudieron cargar los informes guardados.");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
      dispose?.();
    };
  }, []);
  async function analyze(id?: string) {
    if (active.current) return;
    if (!isTauri()) {
      setError("Abre la aplicación de escritorio para elegir un repositorio.");
      return;
    }
    active.current = true;
    cancelling.current = false;
    setBusy(true);
    setError("");
    setProgress(
      id ? "Preparando una revisión nueva…" : "Elige una carpeta local…",
    );
    if (id)
      setReports((items) =>
        items.map((r) =>
          r.id === id
            ? {
                ...r,
                state: "running",
                status: "orange",
                project: null,
                packages: [],
                prompts: [],
                vulnerabilities: null,
                limitations: [],
              }
            : r,
        ),
      );
    try {
      const next = await invoke<RepositoryReport | null>("analyze_repository", {
        id: id ?? null,
      });
      if (next && alive.current) {
        setReports((items) => [next, ...items.filter((r) => r.id !== next.id)]);
        setSelected(next.id);
      }
    } catch {
      if (alive.current) {
        setError(
          "No se pudo iniciar el análisis. Revisa la carpeta y la configuración de IA.",
        );
        try {
          setReports(await request<RepositoryReport[]>("repository_list"));
        } catch {
          /* preserve visible reports */
        }
      }
    } finally {
      active.current = false;
      if (alive.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function cancel() {
    if (cancelling.current) return;
    cancelling.current = true;
    setProgress("Cancelando…");
    try {
      await request("cancel");
    } catch {
      setError("No se pudo confirmar la cancelación.");
    } finally {
      cancelling.current = false;
    }
  }
  async function remove(id: string) {
    try {
      await request("repository_remove", { id });
      setReports((items) => items.filter((r) => r.id !== id));
      if (selected === id) setSelected(null);
    } catch {
      setError("No se pudo quitar el informe.");
    }
  }
  return (
    <section className="repositories" aria-labelledby="repositories-title">
      <header className="repository-heading">
        <h1 id="repositories-title">Repositorios</h1>
        <Button
          className="scan-button"
          disabled={busy || loading}
          onClick={() => void analyze()}
        >
          <Plus aria-hidden="true" /> Agregar
        </Button>
      </header>
      <details className="repository-info">
        <summary>Información del análisis</summary>
        <div>
          <p>
            Un agente revisa arquitectura, dependencias e instrucciones
            maliciosas, en ese orden. No modifica archivos. Envía los textos
            leídos al proveedor de IA configurado y consulta nombres y versiones
            en OSV. Los informes se guardan en este equipo.
          </p>
          <Button
            variant="link"
            className="text-button h-auto"
            onClick={onSettings}
          >
            Configurar proveedor
          </Button>
          <SkillInstructions
            id="repository-analysis"
            name="Análisis de repositorios"
          />
        </div>
      </details>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {busy && (
        <div role="status" className="repository-progress">
          <span className="progress-dot" />
          <span>{progress}</span>
          <Button
            variant="link"
            className="text-button h-auto"
            onClick={() => void cancel()}
          >
            Cancelar
          </Button>
        </div>
      )}
      {loading ? (
        <p className="repository-empty">Cargando…</p>
      ) : !reports.length && !busy ? (
        <div className="repository-empty">
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          <p>Agrega una carpeta para analizarla.</p>
        </div>
      ) : null}
      <div className="repository-grid">
        {reports.map((r) => (
          <Card
            key={r.id}
            className={`repository-card gap-0 py-0 shadow-none status-${r.status}`}
          >
            <Button
              variant="ghost"
              className="repository-select h-auto whitespace-normal rounded-none"
              onClick={() => setSelected(r.id)}
              aria-pressed={r.id === selected}
            >
              <Badge
                variant="ghost"
                className="repository-status rounded-none p-0 font-normal"
              >
                <span />
                {statusLabel(r)}
              </Badge>
              <h2>{r.name}</h2>
              <div className="repository-metrics">
                <span>
                  {r.packages.length}{" "}
                  {r.packages.length === 1 ? "paquete" : "paquetes"}
                </span>
                <span>
                  {r.vulnerabilities?.findings.length ?? 0} avisos OSV
                </span>
                {r.prompts.length > 0 && (
                  <span>
                    {r.prompts.length} sospecha
                    {r.prompts.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <small>
                {new Date(r.completedAt ?? r.startedAt).toLocaleString(
                  "es-MX",
                  {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                )}
              </small>
            </Button>
            <CardFooter className="repository-card-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void analyze(r.id)}
              >
                Volver a analizar
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void remove(r.id)}
              >
                Quitar
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {report && (
        <div className="repository-detail">
          <header>
            <div>
              <h2>{report.name}</h2>
              <p className="repository-path">{report.path}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="detail-close"
              aria-label="Cerrar detalle"
              onClick={() => setSelected(null)}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <section>
            <h3>Arquitectura</h3>
            <p>{report.project?.architecture ?? "Sin completar."}</p>
            {report.project && (
              <details>
                <summary>Ver evidencia</summary>
                {report.project.evidence.map((e, i) => (
                  <EvidenceBlock key={i} evidence={e} />
                ))}
              </details>
            )}
          </section>
          <section>
            <h3>
              Dependencias <span>{report.packages.length}</span>
            </h3>
            {report.vulnerabilities?.findings.map((v, i) => (
              <article className="repository-finding" key={`${v.id}:${i}`}>
                <strong>
                  {v.name}@{v.version}
                </strong>
                <span className="finding-id">{v.id}</span>
                <p>{v.summary}</p>
                <small>OSV · {v.severity ?? "Sin severidad indicada"}</small>
              </article>
            ))}
            {!report.vulnerabilities && (
              <p>Consulta de vulnerabilidades sin completar.</p>
            )}
            <details>
              <summary>Ver paquetes</summary>
              <div className="dependency-scroll">
                <Table className="dependency-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Paquete</TableHead>
                      <TableHead>Ecosistema</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Declarada</TableHead>
                      <TableHead>Exacta</TableHead>
                      <TableHead>Fuente</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.packages.map((p, i) => (
                      <TableRow key={i}>
                        <TableHead scope="row">{p.name}</TableHead>
                        <TableCell>{p.ecosystem}</TableCell>
                        <TableCell>
                          {p.kind === "transitive" ? "Transitiva" : "Directa"}
                        </TableCell>
                        <TableCell>{p.declared}</TableCell>
                        <TableCell>{p.version ?? "Sin resolver"}</TableCell>
                        <TableCell>
                          {p.path}:{p.line}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </section>
          <section>
            <h3>
              Instrucciones sospechosas <span>{report.prompts.length}</span>
            </h3>
            {report.prompts.length ? (
              report.prompts.map((p, i) => (
                <article className="repository-finding" key={i}>
                  <strong>
                    {p.path}:{p.line}
                  </strong>
                  <small className="finding-id">
                    {p.confidence === "high"
                      ? "Alta confianza"
                      : "Revisión manual"}
                  </small>
                  <p>{p.reason}</p>
                  <details>
                    <summary>Ver fragmento</summary>
                    <EvidenceBlock evidence={p} />
                  </details>
                </article>
              ))
            ) : (
              <p>
                {report.state === "completed"
                  ? "Sin hallazgos en los archivos revisados."
                  : "Sin completar."}
              </p>
            )}
          </section>
          <details className="repository-scope">
            <summary>Alcance y fuentes</summary>
            <p>
              {report.provider ?? "Sin proveedor"} /{" "}
              {report.model ?? "Sin modelo"} · {report.coverage.read}/
              {report.coverage.available} archivos leídos ·{" "}
              {report.coverage.omitted} omitidos ·{" "}
              {report.vulnerabilities?.checked ?? 0} paquetes consultados en
              OSV.
            </p>
            {report.limitations.length > 0 && (
              <ul>
                {report.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <p>
              Instantánea tomada al iniciar. Vuelve a analizar después de
              modificar archivos. Verde significa sin hallazgos dentro de esta
              revisión, no seguridad garantizada. La IA puede equivocarse.
            </p>
          </details>
        </div>
      )}
    </section>
  );
}
function EvidenceBlock({ evidence }: { evidence: Evidence }) {
  return (
    <div className="repository-evidence">
      <code>
        {evidence.path}:{evidence.line}
      </code>
      <pre>{evidence.excerpt}</pre>
    </div>
  );
}
