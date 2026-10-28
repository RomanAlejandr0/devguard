import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";
import ProjectInventory from "./ProjectInventory";
import ManagerPackages, { type ManagerInventory } from "./ManagerInventory";

type ToolId = "node" | "python" | "homebrew";
type ToolDetection = {
  id: ToolId;
  name: string;
  status: "found" | "not_found" | "error";
  version: string | null;
  path: string | null;
  detail: string;
};
const tools: { id: ToolId; name: string; kind: string; mark: string }[] = [
  { id: "node", name: "Node.js", kind: "Entorno de JavaScript", mark: "JS" },
  {
    id: "python",
    name: "Python",
    kind: "Intérprete de Python",
    mark: "Py",
  },
  { id: "homebrew", name: "Homebrew", kind: "Gestor de paquetes", mark: "Br" },
];
function Shield({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3 20 6v6c0 4-4.5 7.5-8 9-3.5-1.5-8-5-8-9V6l8-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m8.5 12 2.3 2.3 4.7-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function App() {
  const [inventories, setInventories] = useState<ManagerInventory[]>([]);
  const inFlight = useRef(false);
  const [results, setResults] = useState<ToolDetection[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const foundCount = results.filter((tool) => tool.status === "found").length;
  async function detectTools() {
    if (inFlight.current) return;
    setError(null);
    if (!isTauri()) {
      setError(
        "La detección necesita la aplicación de escritorio de DevGuard. Esta vista en el navegador solo permite explorar la interfaz.",
      );
      return;
    }
    inFlight.current = true;
    setInventories([]);
    setIsScanning(true);
    try {
      const [toolsResult, packagesResult] = await Promise.allSettled([
        invoke<ToolDetection[]>("detect_tools"),
        invoke<ManagerInventory[]>("collect_inventory"),
      ]);
      setResults(toolsResult.status === "fulfilled" ? toolsResult.value : []);
      setInventories(packagesResult.status === "fulfilled" ? packagesResult.value : []);
      if (toolsResult.status === "rejected" || packagesResult.status === "rejected") {
        setError("La consulta quedó incompleta. Vuelve a detectar para reintentarlo.");
      }
      setLastScan(new Date());
    } catch {
      setError(
        "No pudimos completar la detección. Puedes volver a intentarlo; tus herramientas no se han modificado.",
      );
    } finally {
      inFlight.current = false;
      setIsScanning(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="DevGuard">
        <div className="brand">
          <span className="brand-icon">
            <Shield />
          </span>
          <span>
            DevGuard
            
          </span>
        </div>
        <div className="sidebar-section">ESPACIO LOCAL</div>
        <div className="current-section">
          <svg
            width="19"
            height="19"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="3"
              y="3"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
            />
            <rect
              x="12"
              y="3"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
            />
            <rect
              x="3"
              y="12"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
            />
            <rect
              x="12"
              y="12"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
            />
          </svg>
          Mi Mac
          <span className="section-dot" />
        </div>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          <span>
            En este equipo<small>Prototipo · 0.1.0</small>
          </span>
        </div>
      </aside>
      <main>

        <div className="main-content">
          <div className="inventory-heading">
            <div>
              <h1>Herramientas de desarrollo</h1>
            </div>
            <button
              className="scan-button"
              onClick={detectTools}
              disabled={isScanning}
            >
              <svg
                className={isScanning ? "spin" : ""}
                width="17"
                height="17"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M16.4 7A7 7 0 1 0 17 12M16.4 7V2m0 5h-5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {isScanning
                ? "Detectando…"
                : lastScan || error
                  ? "Volver a detectar"
                  : "Detectar herramientas"}
            </button>
          </div>
          <div aria-live="polite" aria-atomic="true" className="scan-feedback">
            {error ? (
              <p className="error-message" role="alert">
                {error}
              </p>
            ) : isScanning ? (
              <p>Consultando las herramientas disponibles en tu equipo…</p>
            ) : lastScan ? (
              <p>
                Detección completada · {foundCount} de 3 herramientas
                encontradas ·{" "}
                {lastScan.toLocaleTimeString("es-MX", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            ) : (
              <p>Aún no se ha realizado ninguna detección.</p>
            )}
          </div>
          <section aria-label="Herramientas detectadas" aria-busy={isScanning}>
            <div className="tool-grid">
              {tools.map((tool) => {
                const result = results.find((entry) => entry.id === tool.id);
                const label = isScanning
                  ? "Detectando"
                  : result?.status === "found"
                    ? "Detectada"
                    : result?.status === "not_found"
                      ? "No encontrada"
                      : result?.status === "error"
                        ? "No se pudo consultar"
                        : "Sin consultar";
                const inventory = inventories.find((entry) => entry.id === (tool.id === "node" ? "npm" : tool.id));
                return (
                  <article
                    className={`tool-card tool-${tool.id}`}
                    key={tool.id}
                  >
                    <div className="tool-card-top">
                      <span className="tool-mark" aria-hidden="true">
                        {tool.mark}
                      </span>
                      <span
                        className={`tool-status ${isScanning ? "pending" : (result?.status ?? "idle")}`}
                      >
                        <span />
                        {label}
                      </span>
                    </div>
                    <h3>{tool.name}</h3>
                    <p className="tool-kind">{tool.kind}</p>
                    <div className="tool-version">
                      <span>VERSIÓN DETECTADA</span>
                      <strong>
                        {isScanning ? "Consultando…" : (result?.version ?? "—")}
                      </strong>
                    </div>
                    <div className="tool-location">
                      <span>Ubicación</span>
                      <code title={result?.path ?? undefined}>
                        {isScanning
                          ? "Buscando ejecutable…"
                          : (result?.path ?? "Pendiente de detección")}
                      </code>
                    </div>
                    {result && result.status !== "found" && !isScanning && (
                      <p
                        className={`tool-detail ${result.status === "error" ? "detail-error" : ""}`}
                      >
                        {result.detail}
                      </p>
                    )}
                    {inventory && !isScanning ? <ManagerPackages inventory={inventory} /> : null}
                  </article>
                );
              })}
            </div>
          </section>
          <ProjectInventory />

        </div>
      </main>
    </div>
  );
}
export default App;
