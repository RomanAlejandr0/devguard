import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

type Dependency = {
  name: string;
  kind: "production" | "development" | "optional" | "peer";
  declared: string;
  resolved: string | null;
};
type ProjectReport = {
  name: string;
  path: string;
  lockfile: string | null;
  warnings: string[];
  dependencies: Dependency[];
};
const kindLabels = {
  production: "Producción",
  development: "Desarrollo",
  optional: "Opcional",
  peer: "Compatibilidad",
};

export default function ProjectInventory() {
  const [project, setProject] = useState<ProjectReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function chooseProject() {
    if (inFlight.current) return;
    setError(null);
    if (!isTauri()) {
      setError("Abre DevGuard como aplicación de escritorio para elegir una carpeta.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const report = await invoke<ProjectReport | null>("choose_node_project");
      if (report) setProject(report);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "No se pudo leer el proyecto. Inténtalo con otra carpeta.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="project-section" aria-labelledby="project-title" aria-busy={pending}>
      <div className="project-heading">
        <h2 id="project-title">Proyecto</h2>
        <button className="project-button" onClick={chooseProject} disabled={pending}>
          {pending ? "Leyendo proyecto…" : project ? "Cambiar proyecto" : "Elegir proyecto"}
        </button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {error ? <p className="project-error" role="alert">{error}</p> : null}
        {!project && !pending && !error ? <p className="project-empty">Elige una carpeta para consultar sus dependencias.</p> : null}
        {pending ? <p className="project-empty">Selecciona una carpeta de Node para leer sus archivos de dependencias.</p> : null}
        {project && !pending ? <p className="project-summary"><strong>{project.name}</strong><span> · {project.dependencies.length} dependencias directas</span></p> : null}
      </div>
      {project ? (
        <div className="project-report">
          <p className="project-path">{project.path}</p>
          {project.warnings.length ? <ul className="project-warnings">{project.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
          {project.dependencies.length ? (
            <div className="dependency-scroll" tabIndex={0} role="region" aria-label="Dependencias del proyecto">
              <table className="dependency-table">
                <caption>{project.lockfile ? `La versión resuelta proviene de ${project.lockfile}.` : "Solo se muestran las versiones declaradas."} No comprueba su instalación ni vulnerabilidades.</caption>
                <thead><tr><th scope="col">Paquete</th><th scope="col">Tipo</th><th scope="col">Declarada</th><th scope="col">Resuelta</th></tr></thead>
                <tbody>{project.dependencies.map((dependency) => <tr key={`${dependency.kind}:${dependency.name}`}><th scope="row">{dependency.name}</th><td>{kindLabels[dependency.kind]}</td><td><code>{dependency.declared}</code></td><td><code>{dependency.resolved ?? "Sin resolver"}</code></td></tr>)}</tbody>
              </table>
            </div>
          ) : <p className="project-empty">Este proyecto no declara dependencias directas.</p>}
        </div>
      ) : null}
    </section>
  );
}
