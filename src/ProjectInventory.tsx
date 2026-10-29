import { useEffect, useRef, useState } from "react";
import SkillInstructions from "./SkillInstructions";
import { listen } from "@tauri-apps/api/event";
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
  const [projects, setProjects] = useState<ProjectReport[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const project = projects.find((entry) => entry.path === selectedPath) ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const [progress,setProgress] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active=true;
    const subscription=listen<{event:string;data:{message?:string}}>("pi-event",({payload})=>{
      if(active&&inFlight.current&&payload.event==="progress")setProgress(payload.data.message?.slice(0,200)??"");
    });
    return ()=>{active=false;void subscription.then(unlisten=>unlisten());};
  }, []);
  async function cancel() {
    cancelled.current=true;
    try {await invoke("pi_request",{method:"cancel",params:{}});setProgress("Cancelación solicitada…");}
    catch {setError("No se pudo confirmar la cancelación. Espera a que termine el análisis.");}
  }

  async function chooseProject() {
    if (inFlight.current) return;
    setError(null);
    if (!isTauri()) {
      setError("Abre DevGuard como aplicación de escritorio para elegir una carpeta.");
      return;
    }
    inFlight.current = true;
    cancelled.current=false;
    setProgress("Elige una carpeta. Pi listará sus paquetes usando el proveedor y modelo de Configuración IA.");
    setPending(true);
    try {
      const report = await invoke<ProjectReport | null>("choose_node_project");
      if (report && !cancelled.current) {
        setProjects((current) => {
          const existing = current.some((entry) => entry.path === report.path);
          return existing
            ? current.map((entry) => entry.path === report.path ? report : entry)
            : [...current, report];
        });
        setSelectedPath(report.path);
      }
    } catch (reason) {
      if (!cancelled.current) setError(typeof reason === "string" ? reason : "Pi no pudo analizar los paquetes. Revisa Configuración IA.");
    } finally {
      inFlight.current = false;
      setPending(false);
      setProgress("");
    }
  }

  function removeProject(path: string) {
    const remaining = projects.filter((entry) => entry.path !== path);
    setProjects(remaining);
    if (selectedPath === path) setSelectedPath(remaining[0]?.path ?? null);
    setError(null);
  }

  return (
    <section className="project-section" aria-labelledby="project-title" aria-busy={pending}>
      <div className="project-heading">
        <h2 id="project-title">Proyectos</h2>
        <button className="project-button" onClick={chooseProject} disabled={pending}>
          {pending ? "Analizando con Pi…" : "Agregar proyecto"}
        </button>
        {pending && <button className="project-button" type="button" onClick={()=>void cancel()}>Cancelar</button>}
      </div>
      <SkillInstructions id="project-packages" name="Paquetes del proyecto" />
      <div aria-live="polite" aria-atomic="true">
        {error ? <p className="project-error" role="alert">{error}</p> : null}
        {!project && !pending && !error ? <p className="project-empty">Agrega carpetas para listar sus paquetes con Pi. Se usa el proveedor y modelo de Configuración IA; se envían solo metadatos de dependencias. Por ahora se admiten proyectos Node.</p> : null}
        {pending ? <p className="project-empty">{progress}</p> : null}
        {project && !pending ? <p className="project-summary"><strong>{project.name}</strong><span> · {project.dependencies.length} dependencias directas</span></p> : null}
      </div>
      {projects.length > 0 && (
        <nav className="project-list" aria-label="Proyectos agregados">
          {projects.map((entry) => (
            <button
              className="project-list-item"
              type="button"
              key={entry.path}
              aria-pressed={entry.path === selectedPath}
              onClick={() => { setSelectedPath(entry.path); setError(null); }}
            >
              <strong>{entry.name}</strong>
              <span>{entry.path}</span>
            </button>
          ))}
        </nav>
      )}
      {project ? (
        <div className="project-report">
          <div className="project-detail-heading">
            <h3>{project.name}</h3>
            <button className="project-remove" type="button" disabled={pending} onClick={() => removeProject(project.path)}>Quitar de la lista</button>
          </div>
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
