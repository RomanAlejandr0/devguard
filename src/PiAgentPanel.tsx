import { useEffect, useId, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./PiAgentPanel.css";
import SkillInstructions from "./SkillInstructions";

type Provider = {
  id: string;
  name: string;
  authenticated: boolean;
  credentialType?: "oauth" | "api_key" | null;
  methods: string[];
};
type Model = { id: string; name: string; provider: string };
type Skill = { id: string; name: string; description: string };
type Catalog = { providers: Provider[]; models: Model[]; skills: Skill[]; selection?: {provider: string; model: string} | null };
type Finding = {
  name: string;
  category: string;
  source: string;
  evidence: string;
  limitations: string[];
};
type Analysis = { summary: string; findings: Finding[]; limitations: string[] };
type PiEvent = {
  event: "progress" | "auth";
  data: { message?: string; url?: string; inputRequired?: boolean };
};
type Action = "check" | "catalog" | "analyze" | "login" | "save" | "logout" | "import";
const LOG_LIMIT = 30;

async function request<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("pi_request", { method, params });
}

type Props = {
  view: "analysis" | "settings";
  onOpenSettings: () => void;
};

export default function PiAgentPanel({ view, onOpenSettings }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [connectionMode, setConnectionMode] = useState<"oauth" | "api_key">("oauth");
  const [editingConnection, setEditingConnection] = useState(false);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [apiKey, setApiKey] = useState("");
  const [authInput, setAuthInput] = useState("");
  const [authPrompt, setAuthPrompt] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [inputRequired, setInputRequired] = useState(false);
  const [sendingInput, setSendingInput] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const alive = useRef(false);
  const activeAction = useRef<Action | null>(null);
  const inputInFlight = useRef(false);
  const cancelled = useRef(false);
  const listenerReady = useRef<Promise<void> | null>(null);
  const secrets = useRef<string[]>([]);
  const ids = useId();
  const provider = catalog?.providers.find((entry) => entry.id === providerId);
  const models =
    catalog?.models.filter((entry) => entry.provider === providerId) ?? [];
  const supported =
    provider?.methods.map((method) => method.toLowerCase()) ?? [];
  const supportsOAuth = supported.some((method) => /oauth|login/.test(method));
  const supportsKey = supported.some((method) => /key|token/.test(method));
  const busy = action !== null;
  const connectionKey = `${providerId}:${modelId}`;
  const isVerified = Boolean(provider?.authenticated && verified[connectionKey]);
  const showConnectionForm = !provider?.authenticated || editingConnection;
  const oauthMode = supportsOAuth && (connectionMode === "oauth" || !supportsKey);
  const connectionLabel = !provider?.authenticated ? "Sin conexión" : isVerified ? "Conexión comprobada" : "Credencial guardada · sin comprobar";

  function safeMessage(message: string) {
    let safe = message;
    for (const secret of secrets.current) {
      if (secret) safe = safe.split(secret).join("[oculto]");
    }
    return safe
      .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[oculto]")
      .slice(0, 400);
  }

  useEffect(() => {
    alive.current = true;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    if (isTauri()) {
      const ready = listen<PiEvent>("pi-event", ({ payload }) => {
        if (!active || !activeAction.current) return;
        if (payload.event === "progress" && payload.data.message) {
          const message = safeMessage(payload.data.message);
          setLogs((current) => [...current.slice(-(LOG_LIMIT - 1)), message]);
        }
        if (payload.event === "auth") {
          setAuthPrompt(
            payload.data.message
              ? safeMessage(payload.data.message)
              : "Completa la autorización del proveedor.",
          );
          setAuthUrl(payload.data.url ?? "");
          setInputRequired(Boolean(payload.data.inputRequired));
        }
      }).then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      });
      listenerReady.current = ready;
      void ready.catch(() => {
        if (active)
          setError(
            "No pudimos conectar los eventos de Pi. Vuelve a abrir este panel para intentarlo de nuevo.",
          );
      });
    }
    return () => {
      active = false;
      alive.current = false;
      unlisten?.();
      if (
        activeAction.current === "analyze" ||
        activeAction.current === "login" ||
        activeAction.current === "check"
      ) {
        void request("cancel").catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!catalog || !providerId || !modelId || !isTauri()) return;
    let current = true;
    void request("configure", {provider:providerId,model:modelId}).catch(() => {
      if (current) setError("No se pudo guardar el proveedor y modelo para Proyectos. Vuelve a seleccionarlos.");
    });
    return () => {current=false;};
  }, [catalog,providerId,modelId]);

  function applyCatalog(next: Catalog) {
    setCatalog(next);
    const nextProvider =
      next.providers.find((entry) => entry.id === providerId) ??
      next.providers.find((entry) => entry.id === next.selection?.provider) ??
      next.providers.find((entry) => entry.authenticated) ??
      next.providers[0];
    const nextModels = next.models.filter(
      (entry) => entry.provider === nextProvider?.id,
    );
    setProviderId(nextProvider?.id ?? "");
    setModelId(
      nextModels.find((entry) => entry.id === modelId)?.id ??
        nextModels.find((entry) => entry.id === next.selection?.model)?.id ??
        nextModels[0]?.id ??
        "",
    );
    setSelectedSkills((current) =>
      current.length ? current.filter((id) => next.skills.some((skill) => skill.id === id)) : next.skills.map(skill => skill.id),
    );
  }

  async function run(kind: Action, work: () => Promise<void>) {
    if (activeAction.current) return;
    setError(null);
    setNotice(null);
    if (!isTauri()) {
      setError(
        "El agente Pi necesita la aplicación de escritorio y Node instalado en el equipo.",
      );
      return;
    }
    activeAction.current = kind;
    cancelled.current = false;
    setAction(kind);
    try {
      if (!listenerReady.current) throw new Error("Listener unavailable");
      await listenerReady.current;
      if (alive.current) await work();
    } catch {
      if (["login", "save", "logout", "import"].includes(kind)) {
        try { await refreshAuthentication(); } catch { /* Keep the last known state. */ }
      }
      if (alive.current && !cancelled.current) {
        setError(
          kind === "check"
            ? "No se pudo comprobar la conexión con este modelo. La credencial sigue guardada, pero no hemos confirmado que funcione. Revisa el acceso al modelo o cambia la conexión."
            : kind === "login"
              ? "No se completó el inicio de sesión. Revisa el estado de la credencial guardada antes de reintentarlo."
              : kind === "save"
                ? "No se pudo guardar la clave API."
                : kind === "logout"
                  ? "No se pudo desconectar el proveedor."
                  : kind === "catalog"
            ? "No pudimos cargar Pi. Comprueba que Node esté disponible y vuelve a intentarlo."
            : kind === "import"
              ? "No pudimos importar una sesión válida de Pi para este proveedor. Puedes iniciar sesión o configurar una clave."
              : kind === "analyze"
                ? "El análisis no pudo completarse. Revisa la conexión del proveedor y vuelve a intentarlo."
                : "No pudimos completar la operación con el proveedor. Vuelve a intentarlo.",
        );
      }
    } finally {
      activeAction.current = null;
      if (alive.current) {
        setAction(null);
        setCancelling(false);
        setAuthInput("");
        setInputRequired(false);
        setAuthUrl("");
        setAuthPrompt("");
      }
    }
  }

  function loadCatalog() {
    void run("catalog", async () => {
      const next = await request<Catalog>("catalog");
      if (alive.current) applyCatalog(next);
    });
  }

  async function refreshAuthentication() {
    const next = await request<Catalog>("catalog");
    if (alive.current) applyCatalog(next);
  }

  function authenticate(kind: "login" | "save" | "logout" | "import") {
    if (!provider || busy) return;
    const selectedProvider = provider.id;
    setVerified({});
    const key = apiKey.trim();
    if (kind === "save" && !key) return;
    if (key && kind === "save") {
      secrets.current = [...secrets.current.slice(-4), key];
      setApiKey("");
    }
    void run(kind, async () => {
      setLogs([]);
      const method =
        kind === "login"
          ? "auth_login"
          : kind === "save"
            ? "auth_set"
            : kind === "import"
              ? "auth_import"
              : "auth_logout";
      await request(
        method,
        kind === "save"
          ? { provider: selectedProvider, apiKey: key }
          : { provider: selectedProvider },
      );
      if (!alive.current || cancelled.current) return;
      await refreshAuthentication();
      setEditingConnection(false);
      if (alive.current)
        setNotice(
          kind === "logout"
            ? "Sesión desconectada de DevGuard."
            : "Credencial guardada. Pulsa «Comprobar conexión» para verificar el acceso al modelo.",
        );
    });
  }

  function checkConnection() {
    if (busy) return;
    setVerified((current) => ({ ...current, [connectionKey]: false }));
    void run("check", async () => {
      await request("auth_check", { provider: providerId, model: modelId });
      if (alive.current && !cancelled.current) {
        setVerified((current) => ({ ...current, [connectionKey]: true }));
        setNotice("El modelo respondió correctamente. Conexión comprobada.");
      }
    });
  }

  async function submitAuthInput() {
    const value = authInput.trim();
    if (!value || inputInFlight.current || action !== "login") return;
    inputInFlight.current = true;
    secrets.current = [...secrets.current.slice(-4), value];
    setAuthInput("");
    setSendingInput(true);
    try {
      await request("auth_input", { value });
      if (alive.current) setInputRequired(false);
    } catch {
      if (alive.current)
        setError(
          "No pudimos enviar la respuesta de autorización. Vuelve a intentarlo.",
        );
    } finally {
      inputInFlight.current = false;
      if (alive.current) setSendingInput(false);
    }
  }

  function analyze() {
    if (!provider?.authenticated || !modelId) return;
    void run("analyze", async () => {
      setLogs([]);
      setAnalysis(null);
      const result = await request<Analysis>("analyze", {
        provider: provider.id,
        model: modelId,
        skills: selectedSkills,
      });
      if (alive.current && !cancelled.current) {
        setAnalysis(result);
        setVerified((current) => ({ ...current, [connectionKey]: true }));
      }
    });
  }

  async function cancel() {
    if (cancelling || !activeAction.current) return;
    cancelled.current = true;
    setCancelling(true);
    try {
      await request("cancel");
      if (alive.current) setNotice("Cancelación solicitada.");
    } catch {
      if (alive.current) {
        setError(
          "No pudimos confirmar la cancelación. Espera a que termine la operación antes de iniciar otra.",
        );
        setCancelling(false);
      }
    }
  }

  async function openAuthPage() {
    try {
      await invoke("pi_open_auth_url", { url: authUrl });
    } catch {
      if (alive.current)
        setError(
          "No pudimos abrir el navegador. Puedes copiar la dirección de autorización y abrirla manualmente.",
        );
    }
  }

  return (
    <section className="pi-panel" aria-labelledby={`${ids}-title`}>
      <div className="pi-heading">
        <div>
          <h1 id={`${ids}-title`}>{view === "settings" ? "Configuración IA" : "Agente IA"}</h1>
          <p>
            {view === "settings"
              ? "Elige el proveedor, el modelo y su conexión."
              : "Analiza el inventario y consulta los resultados del agente."}
          </p>
        </div>
        <button
          className="pi-button"
          type="button"
          disabled={busy}
          onClick={view === "settings" ? loadCatalog : onOpenSettings}
        >
          {view !== "settings" ? "Configurar IA" : action === "catalog"
            ? "Cargando…"
            : catalog
              ? "Actualizar proveedores"
              : "Cargar proveedores"}
        </button>
      </div>
      <p className="pi-scope" hidden={view !== "analysis"}>
        Al iniciar un análisis, se enviará el inventario al proveedor y modelo
        elegidos. El agente trabaja en modo de solo lectura, sin acceso a una
        terminal ni permiso para modificar tus herramientas.
      </p>
      {catalog && (
        <>
        <div className="pi-settings" hidden={view !== "settings"}>
          <div className="pi-select-row">
            <label htmlFor={`${ids}-provider`}>
              Proveedor
              <select
                id={`${ids}-provider`}
                value={providerId}
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setProviderId(next);
                  setModelId(
                    catalog.models.find((model) => model.provider === next)
                      ?.id ?? "",
                  );
                  setApiKey("");
                  setEditingConnection(false);
                  setConnectionMode("oauth");
                  setError(null);
                  setNotice(null);
                }}
              >
                {catalog.providers.length === 0 && (
                  <option value="">Sin proveedores disponibles</option>
                )}
                {catalog.providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.authenticated ? " · credencial guardada" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${ids}-model`}>
              Modelo
              <select
                id={`${ids}-model`}
                value={modelId}
                disabled={busy || models.length === 0}
                onChange={(event) => { setModelId(event.currentTarget.value); setError(null); setNotice(null); }}
              >
                {models.length === 0 && (
                  <option value="">Sin modelos disponibles</option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {provider && (
            <div className="pi-auth">
              <div className="pi-auth-heading">
                <strong className={`pi-connection ${isVerified ? "connected" : ""}`}>{connectionLabel}</strong>
                {provider.authenticated && <span>{provider.credentialType === "oauth" ? "Acceso con cuenta / suscripción" : "Acceso con clave API"}</span>}
              </div>
              {provider.authenticated && (
                <>
                  <div className="pi-auth-actions">
                    <button className="pi-button" type="button" disabled={busy || !modelId} onClick={checkConnection}>
                      {action === "check" ? "Comprobando…" : "Comprobar conexión"}
                    </button>
                    <button className="pi-button pi-secondary" type="button" disabled={busy} onClick={() => { setEditingConnection(!editingConnection); setError(null); setNotice(null); }}>
                      {editingConnection ? "Cerrar opciones" : "Cambiar conexión"}
                    </button>
                    <button className="pi-button pi-secondary" type="button" disabled={busy} onClick={() => authenticate("logout")}>Desconectar</button>
                  </div>
                  <p className="pi-auth-note">La comprobación envía una consulta breve al modelo, sin enviar tu inventario. Puede consumir uso del proveedor.</p>
                </>
              )}
              {showConnectionForm && (
                <div className="pi-connection-form">
                  {supportsOAuth && supportsKey && (
                    <div className="pi-methods" role="group" aria-label="Cómo conectar">
                      <button className="pi-button" type="button" aria-pressed={oauthMode} disabled={busy} onClick={() => {setConnectionMode("oauth");setError(null);}}>Cuenta / suscripción</button>
                      <button className="pi-button" type="button" aria-pressed={!oauthMode} disabled={busy} onClick={() => {setConnectionMode("api_key");setError(null);}}>Clave API</button>
                    </div>
                  )}
                  {oauthMode ? (
                    <>
                      <p className="pi-auth-note">Conecta tu cuenta mediante el inicio de sesión oficial del proveedor. No necesitas una clave API.</p>
                      <button className="pi-button" type="button" disabled={busy} onClick={() => authenticate("login")}>
                        {action === "login" ? "Esperando autorización…" : `Iniciar sesión en ${provider.name}`}
                      </button>
                    </>
                  ) : supportsKey ? (
                    <form className="pi-key-form" onSubmit={(event) => {event.preventDefault();authenticate("save");}}>
                      <label htmlFor={`${ids}-key`}>Clave API
                        <input id={`${ids}-key`} type="password" value={apiKey} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder="Clave del proveedor seleccionado" />
                      </label>
                      <button className="pi-button" type="submit" disabled={busy || !apiKey.trim()}>Guardar clave API</button>
                    </form>
                  ) : <p className="pi-auth-note">Este proveedor no ofrece un método de conexión compatible en esta pantalla.</p>}
                  <details className="pi-import">
                    <summary>Importar una conexión existente de Pi</summary>
                    <p className="pi-auth-note">Copia la credencial de este proveedor desde Pi al almacenamiento privado de DevGuard.</p>
                    <button className="pi-button pi-secondary" type="button" disabled={busy} onClick={() => authenticate("import")}>Importar conexión de Pi</button>
                  </details>
                </div>
              )}
            </div>
          )}
        </div>
        <div hidden={view !== "analysis"}>
          <p className="pi-model-summary">
            {provider?.name} · {models.find((model) => model.id === modelId)?.name || "Sin modelo"}
            <span className={`pi-connection ${provider?.authenticated ? "connected" : ""}`}>
              {connectionLabel}
            </span>
          </p>
          <fieldset className="pi-skills" disabled={busy}>
            <legend>Skills para este análisis</legend>
            {catalog.skills.length === 0 ? (
              <p>No hay skills disponibles.</p>
            ) : (
              catalog.skills.map((skill) => (
                <div key={skill.id}>
                <label className="pi-skill">
                  <input
                    type="checkbox"
                    checked={selectedSkills.includes(skill.id)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelectedSkills((current) =>
                        checked
                          ? [...current, skill.id]
                          : current.filter((id) => id !== skill.id),
                      );
                    }}
                  />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </span>
                </label>
                <SkillInstructions id={skill.id} name={skill.name} />
                </div>
              ))
            )}
          </fieldset>
          <div className="pi-run-row">
            <button
              className="pi-button pi-primary"
              type="button"
              disabled={busy || !provider?.authenticated || !modelId}
              onClick={analyze}
            >
              {action === "analyze" ? "Analizando…" : "Analizar inventario"}
            </button>
            {action === "analyze" && (
              <button
                className="pi-button pi-secondary"
                type="button"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? "Cancelando…" : "Cancelar"}
              </button>
            )}
            {!provider?.authenticated && (
              <p>Conecta el proveedor para iniciar.</p>
            )}
          </div>
        </div>
        </>
      )}
      {!catalog && view === "analysis" && (
        <p className="pi-scope">Configura una conexión para comenzar tu primer análisis.</p>
      )}
      <div hidden={view !== "settings"}>
      {(action === "login" || action === "check") && (
        <button className="pi-button pi-secondary" type="button" disabled={cancelling} onClick={() => void cancel()}>
          {cancelling ? "Cancelando…" : "Cancelar operación"}
        </button>
      )}
      {(authPrompt || authUrl || inputRequired) && (
        <div className="pi-auth-prompt">
          <p>{authPrompt || "Completa la autorización del proveedor."}</p>
          {authUrl && (
            <>
              <label htmlFor={`${ids}-url`}>
                Dirección de autorización
                <input
                  id={`${ids}-url`}
                  className="pi-auth-url"
                  readOnly
                  value={authUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button
                className="pi-button"
                type="button"
                onClick={() => void openAuthPage()}
              >
                Abrir inicio de sesión
              </button>
            </>
          )}
          {inputRequired && (
            <form
              className="pi-key-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAuthInput();
              }}
            >
              <label htmlFor={`${ids}-input`}>
                Respuesta de autorización
                <input
                  id={`${ids}-input`}
                  type="password"
                  autoComplete="off"
                  value={authInput}
                  disabled={sendingInput || cancelling}
                  onChange={(event) => setAuthInput(event.currentTarget.value)}
                />
              </label>
              <button
                className="pi-button"
                type="submit"
                disabled={sendingInput || cancelling || !authInput.trim()}
              >
                {sendingInput ? "Enviando…" : "Enviar respuesta"}
              </button>
            </form>
          )}
        </div>
      )}
      </div>
      <div className="pi-feedback" aria-live="polite" aria-atomic="true">
        {error && (
          <p className="pi-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p>{notice}</p>}
      </div>
      <div hidden={view !== "analysis"}>
      {logs.length > 0 && (
        <details className="pi-progress" open={busy || undefined}>
          <summary>Actividad de Pi</summary>
          <ol>
            {logs.map((line, index) => (
              <li key={`${index}:${line}`}>{line}</li>
            ))}
          </ol>
        </details>
      )}
      {analysis && (
        <div className="pi-result">
          <h3>Resultado del análisis</h3>
          <p className="pi-result-summary">{analysis.summary}</p>
          {analysis.findings.length === 0 ? (
            <p className="pi-empty-findings">
              El agente no reportó hallazgos. Esto no garantiza que el entorno
              esté libre de riesgos.
            </p>
          ) : (
            <div className="pi-findings">
              {analysis.findings.map((finding, index) => (
                <article
                  className="pi-finding"
                  key={`${finding.name}:${index}`}
                >
                  <div>
                    <h4>{finding.name}</h4>
                    <span>{finding.category}</span>
                  </div>
                  <dl>
                    <dt>Fuente</dt>
                    <dd>{finding.source}</dd>
                    <dt>Evidencia</dt>
                    <dd>{finding.evidence}</dd>
                  </dl>
                  {finding.limitations.length > 0 && (
                    <>
                      <h5>Limitaciones</h5>
                      <ul>
                        {finding.limitations.map((item, itemIndex) => (
                          <li key={itemIndex}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
          {analysis.limitations.length > 0 && (
            <div className="pi-limitations">
              <h4>Limitaciones del análisis</h4>
              <ul>
                {analysis.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      </div>
    </section>
  );
}
