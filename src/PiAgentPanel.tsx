import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./PiAgentPanel.css";

type Provider = {
  id: string;
  name: string;
  authenticated: boolean;
  credentialType?: "oauth" | "api_key" | null;
  methods: string[];
};
type Model = { id: string; name: string; provider: string };
type Catalog = {
  providers: Provider[];
  models: Model[];
  selection?: { provider: string; model: string } | null;
};
type PiEvent = {
  event: "progress" | "auth";
  data: { message?: string; url?: string; inputRequired?: boolean };
};
type Action = "check" | "catalog" | "login" | "save" | "logout" | "import";

async function request<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("pi_request", { method, params });
}

export default function PiAgentPanel() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [connectionMode, setConnectionMode] = useState<"oauth" | "api_key">(
    "oauth",
  );
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
  const isVerified = Boolean(
    provider?.authenticated && verified[connectionKey],
  );
  const showConnectionForm = !provider?.authenticated || editingConnection;
  const oauthMode =
    supportsOAuth && (connectionMode === "oauth" || !supportsKey);
  const connectionLabel = !provider?.authenticated
    ? "Sin conexión"
    : isVerified
      ? "Conexión comprobada"
      : "Credencial guardada · sin comprobar";

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
    void request("configure", { provider: providerId, model: modelId }).catch(
      () => {
        if (current)
          setError(
            "No se pudo guardar el proveedor y modelo para repositorios. Vuelve a seleccionarlos.",
          );
      },
    );
    return () => {
      current = false;
    };
  }, [catalog, providerId, modelId]);

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
        try {
          await refreshAuthentication();
        } catch {
          /* Keep the last known state. */
        }
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
          <h1 id={`${ids}-title`}>Configuración IA</h1>
        </div>
        <Button
          size="sm"
          className="pi-button"
          type="button"
          disabled={busy}
          onClick={loadCatalog}
        >
          {action === "catalog"
            ? "Cargando…"
            : catalog
              ? "Actualizar"
              : "Cargar proveedores"}
        </Button>
      </div>
      {catalog && (
        <>
          <Card className="pi-settings gap-0 shadow-none">
            <div className="pi-select-row">
              <Label htmlFor={`${ids}-provider`}>
                Proveedor
                <NativeSelect
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
                    <NativeSelectOption value="">
                      Sin proveedores disponibles
                    </NativeSelectOption>
                  )}
                  {catalog.providers.map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.authenticated ? " · credencial guardada" : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label htmlFor={`${ids}-model`}>
                Modelo
                <NativeSelect
                  id={`${ids}-model`}
                  value={modelId}
                  disabled={busy || models.length === 0}
                  onChange={(event) => {
                    setModelId(event.currentTarget.value);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  {models.length === 0 && (
                    <NativeSelectOption value="">
                      Sin modelos disponibles
                    </NativeSelectOption>
                  )}
                  {models.map((model) => (
                    <NativeSelectOption key={model.id} value={model.id}>
                      {model.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
            </div>
            {provider && (
              <div className="pi-auth">
                <div className="pi-auth-heading">
                  <Badge
                    variant="outline"
                    className={`pi-connection ${isVerified ? "connected" : ""}`}
                  >
                    {connectionLabel}
                  </Badge>
                  {provider.authenticated && (
                    <span>
                      {provider.credentialType === "oauth"
                        ? "Acceso con cuenta / suscripción"
                        : "Acceso con clave API"}
                    </span>
                  )}
                </div>
                {provider.authenticated && (
                  <>
                    <div className="pi-auth-actions">
                      <Button
                        size="sm"
                        className="pi-button"
                        type="button"
                        disabled={busy || !modelId}
                        onClick={checkConnection}
                      >
                        {action === "check"
                          ? "Comprobando…"
                          : "Comprobar conexión"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="pi-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingConnection(!editingConnection);
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        {editingConnection
                          ? "Cerrar opciones"
                          : "Cambiar conexión"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="pi-button"
                        type="button"
                        disabled={busy}
                        onClick={() => authenticate("logout")}
                      >
                        Desconectar
                      </Button>
                    </div>
                    <p className="pi-auth-note">
                      La comprobación envía una consulta breve al modelo, sin
                      enviar archivos del repositorio. Puede consumir uso del
                      proveedor.
                    </p>
                  </>
                )}
                {showConnectionForm && (
                  <div className="pi-connection-form">
                    {supportsOAuth && supportsKey && (
                      <div
                        className="pi-methods"
                        role="group"
                        aria-label="Cómo conectar"
                      >
                        <Button
                          size="sm"
                          className="pi-button"
                          type="button"
                          aria-pressed={oauthMode}
                          disabled={busy}
                          onClick={() => {
                            setConnectionMode("oauth");
                            setError(null);
                          }}
                        >
                          Cuenta / suscripción
                        </Button>
                        <Button
                          size="sm"
                          className="pi-button"
                          type="button"
                          aria-pressed={!oauthMode}
                          disabled={busy}
                          onClick={() => {
                            setConnectionMode("api_key");
                            setError(null);
                          }}
                        >
                          Clave API
                        </Button>
                      </div>
                    )}
                    {oauthMode ? (
                      <>
                        <p className="pi-auth-note">
                          Conecta tu cuenta mediante el inicio de sesión oficial
                          del proveedor. No necesitas una clave API.
                        </p>
                        <Button
                          size="sm"
                          className="pi-button"
                          type="button"
                          disabled={busy}
                          onClick={() => authenticate("login")}
                        >
                          {action === "login"
                            ? "Esperando autorización…"
                            : `Iniciar sesión en ${provider.name}`}
                        </Button>
                      </>
                    ) : supportsKey ? (
                      <form
                        className="pi-key-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          authenticate("save");
                        }}
                      >
                        <Label htmlFor={`${ids}-key`}>
                          Clave API
                          <Input
                            id={`${ids}-key`}
                            type="password"
                            value={apiKey}
                            disabled={busy}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) =>
                              setApiKey(event.currentTarget.value)
                            }
                            placeholder="Clave del proveedor seleccionado"
                          />
                        </Label>
                        <Button
                          size="sm"
                          className="pi-button"
                          type="submit"
                          disabled={busy || !apiKey.trim()}
                        >
                          Guardar clave API
                        </Button>
                      </form>
                    ) : (
                      <p className="pi-auth-note">
                        Este proveedor no ofrece un método de conexión
                        compatible en esta pantalla.
                      </p>
                    )}
                    <details className="pi-import">
                      <summary>Importar una conexión existente de Pi</summary>
                      <p className="pi-auth-note">
                        Copia la credencial de este proveedor desde Pi al
                        almacenamiento privado de DevGuard.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="pi-button"
                        type="button"
                        disabled={busy}
                        onClick={() => authenticate("import")}
                      >
                        Importar conexión de Pi
                      </Button>
                    </details>
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}
      <div>
        {(action === "login" || action === "check") && (
          <Button
            size="sm"
            variant="outline"
            className="pi-button"
            type="button"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? "Cancelando…" : "Cancelar operación"}
          </Button>
        )}
        {(authPrompt || authUrl || inputRequired) && (
          <div className="pi-auth-prompt">
            <p>{authPrompt || "Completa la autorización del proveedor."}</p>
            {authUrl && (
              <>
                <Label htmlFor={`${ids}-url`}>
                  Dirección de autorización
                  <Input
                    id={`${ids}-url`}
                    className="pi-auth-url"
                    readOnly
                    value={authUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </Label>
                <Button
                  size="sm"
                  className="pi-button"
                  type="button"
                  onClick={() => void openAuthPage()}
                >
                  Abrir inicio de sesión
                </Button>
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
                <Label htmlFor={`${ids}-input`}>
                  Respuesta de autorización
                  <Input
                    id={`${ids}-input`}
                    type="password"
                    autoComplete="off"
                    value={authInput}
                    disabled={sendingInput || cancelling}
                    onChange={(event) =>
                      setAuthInput(event.currentTarget.value)
                    }
                  />
                </Label>
                <Button
                  size="sm"
                  className="pi-button"
                  type="submit"
                  disabled={sendingInput || cancelling || !authInput.trim()}
                >
                  {sendingInput ? "Enviando…" : "Enviar respuesta"}
                </Button>
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
    </section>
  );
}
