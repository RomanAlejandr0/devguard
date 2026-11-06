import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, mkdir, chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { analyzeRepository } from "./repository-analysis.mjs";
import { repositoryStore } from "./repository-store.mjs";
const { AuthStorage } = await import(
  new URL(
    "./core/auth-storage.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  )
);
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DEVGUARD_PI_DIR;
if (!dataDir) throw Error("DEVGUARD_PI_DIR requerido");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const repositories = repositoryStore(dataDir);
const auth = AuthStorage.create(join(dataDir, "auth.json"));
async function installationId() {
  const path = join(dataDir, "installation-id");
  try {
    const id = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("Identificador inválido");
    return id;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const id = randomUUID();
    try {
      await writeFile(path, id, { flag: "wx", mode: 0o600 });
      return id;
    } catch (error) {
      if (error.code === "EEXIST") return installationId();
      throw error;
    }
  }
}
let selection = null;
try {
  selection = JSON.parse(readFileSync(join(dataDir, "selection.json"), "utf8"));
} catch {}
let runtime;
async function models() {
  return (runtime ??= await ModelRuntime.create({
    credentials: auth,
    modelsPath: null,
    modelsStorePath: join(dataDir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  }));
}
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const progress = (message) => send({ event: "progress", data: { message } });
const pending = new Map();
let serial = 0,
  session,
  operation,
  inputPrompt;
function bridge(tool, args = {}, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Cancelado"));
    const id = "tool-" + ++serial;
    const timer = setTimeout(
      () => finish(Error("Lectura agotó el tiempo")),
      45000,
    );
    const aborted = () => finish(Error("Cancelado"));
    function finish(error, result) {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve(result);
    }
    pending.set(id, (frame) =>
      finish(
        frame.error ? Error("No se pudo leer esta fuente") : null,
        frame.result,
      ),
    );
    signal?.addEventListener("abort", aborted, { once: true });
    send({ toolCallId: id, tool, args });
  });
}
async function catalog() {
  const r = await models();
  const creds = await auth.list();
  return {
    providers: r
      .getProviders()
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        authenticated: creds.some((c) => c.providerId === p.id),
        credentialType: creds.find((c) => c.providerId === p.id)?.type ?? null,
        methods: [
          ...(p.auth?.apiKey ? ["api_key"] : []),
          ...(p.auth?.oauth
            ? [p.auth.oauth.isSubscription ? "oauth_subscription" : "oauth"]
            : []),
        ],
      })),
    models: r
      .getModels()
      .map((m) => ({ id: m.id, name: m.name ?? m.id, provider: m.provider })),
    selection,
  };
}
function emptyResources(prompt) {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
async function checkConnection(params) {
  if (operation) throw Error("Ya hay una operación en curso");
  const controller = new AbortController();
  operation = controller;
  const timeout = setTimeout(() => {
    controller.abort();
    void session?.abort();
  }, 60000);
  try {
    const r = await models();
    const model = r.getModel(params.provider, params.model);
    if (!model) throw Error("Modelo no disponible");
    ({ session } = await createAgentSession({
      cwd: dataDir,
      agentDir: dataDir,
      modelRuntime: r,
      model,
      thinkingLevel: "off",
      resourceLoader: emptyResources("Responde únicamente OK."),
      tools: [],
      customTools: [],
      sessionManager: SessionManager.inMemory(dataDir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: { enabled: false },
      }),
    }));
    if (session.getActiveToolNames().length)
      throw Error("Herramientas no autorizadas");
    if (controller.signal.aborted) throw Error("Cancelado");
    controller.signal.addEventListener("abort", () => void session?.abort(), {
      once: true,
    });
    await session.prompt("Responde OK para comprobar la conexión.");
    const reply = session.messages.findLast((m) => m.role === "assistant");
    if (
      controller.signal.aborted ||
      !reply ||
      ["error", "aborted"].includes(reply.stopReason)
    )
      throw Error("El proveedor no respondió");
    return { verified: true };
  } finally {
    clearTimeout(timeout);
    session?.dispose();
    session = undefined;
    if (operation === controller) operation = undefined;
  }
}
async function runRepository() {
  if (operation) throw Error("Ya hay una operación en curso");
  const controller = new AbortController();
  operation = controller;
  const configured = selection && { ...selection };
  const timeout = setTimeout(() => {
    controller.abort();
    void session?.abort();
  }, 600000);
  try {
    progress("Leyendo la carpeta autorizada…");
    const snapshot = await bridge("repository_snapshot", {}, controller.signal);
    const skill = await readFile(
      join(root, "skills/repository-analysis/SKILL.md"),
      "utf8",
    );
    return await analyzeRepository({
      snapshot,
      selection: configured,
      skill,
      signal: controller.signal,
      progress,
      persist: (report) => repositories.put(report),
      async makeSession(tools, prompt) {
        const r = await models();
        const model =
          configured && r.getModel(configured.provider, configured.model);
        if (!model) throw Error("Configura proveedor y modelo");
        ({ session } = await createAgentSession({
          cwd: dataDir,
          agentDir: dataDir,
          modelRuntime: r,
          model,
          thinkingLevel: "off",
          resourceLoader: emptyResources(prompt),
          tools: tools.map((t) => t.name),
          customTools: tools,
          sessionManager: SessionManager.inMemory(dataDir),
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
            cacheWarming: { enabled: false },
          }),
        }));
        if (controller.signal.aborted) {
          await session.abort();
          throw Error("Cancelado");
        }
        controller.signal.addEventListener(
          "abort",
          () => void session?.abort(),
          { once: true },
        );
        return session;
      },
    });
  } finally {
    clearTimeout(timeout);
    session = undefined;
    if (operation === controller) operation = undefined;
  }
}
async function method(name, p = {}) {
  if (name === "catalog") return catalog();
  if (name === "repository_list")
    return (await repositories.list()).map((report) =>
      report.state === "running" && !operation
        ? {
            ...report,
            state: "interrupted",
            status: "orange",
            limitations: [
              ...report.limitations,
              "El análisis se interrumpió al cerrar la aplicación. Vuelve a analizar.",
            ],
          }
        : report,
    );
  if (name === "repository_get") {
    const report = (await repositories.list()).find((r) => r.id === p.id);
    if (!report) throw Error("Repositorio desconocido");
    return report;
  }
  if (name === "repository_remove") {
    if (operation) throw Error("Espera a que termine el análisis");
    await repositories.remove(p.id);
    return { removed: true };
  }
  if (name === "analyze_repository") return runRepository();
  if (name === "skill_read") {
    if (p.id !== "repository-analysis") throw Error("Skill no permitida");
    return {
      id: p.id,
      instructions: await readFile(
        join(root, "skills", p.id, "SKILL.md"),
        "utf8",
      ),
    };
  }
  if (name === "configure") {
    const r = await models();
    if (!r.getModel(p.provider, p.model)) throw Error("Modelo no disponible");
    selection = { provider: p.provider, model: p.model };
    writeFileSync(join(dataDir, "selection.json"), JSON.stringify(selection), {
      mode: 0o600,
    });
    return { saved: true };
  }
  if (name === "auth_check") return checkConnection(p);
  if (name === "cancel") {
    operation?.abort();
    await session?.abort();
    inputPrompt?.reject(Error("Cancelado"));
    inputPrompt = undefined;
    return { cancelled: true };
  }
  const r = await models();
  const provider = r.getProvider(p.provider);
  if (name === "auth_input") {
    if (!inputPrompt) throw Error("No hay solicitud de entrada");
    inputPrompt.resolve(String(p.value ?? ""));
    inputPrompt = undefined;
    return { accepted: true };
  }
  if (!provider) throw Error("Proveedor desconocido");
  if (operation) throw Error("Espera a que termine la operación");
  if (name === "auth_import") {
    const credential = readStoredCredential(
      p.provider,
      join(homedir(), ".pi", "agent", "auth.json"),
    );
    if (
      !credential ||
      !["oauth", "api_key"].includes(credential.type) ||
      (credential.type === "api_key" &&
        (typeof credential.key !== "string" || credential.key.startsWith("!")))
    )
      throw Error("No hay credencial literal compatible");
    await auth.modify(p.provider, async () => credential);
    runtime = undefined;
    return { authenticated: true };
  }
  if (name === "auth_set") {
    if (
      !provider.auth?.apiKey ||
      typeof p.apiKey !== "string" ||
      !p.apiKey.trim() ||
      p.apiKey.startsWith("!")
    )
      throw Error("Clave no compatible");
    await auth.modify(p.provider, async () => ({
      type: "api_key",
      key: p.apiKey,
    }));
    runtime = undefined;
    return { authenticated: true };
  }
  if (name === "auth_logout") {
    await r.logout(p.provider);
    runtime = undefined;
    return { authenticated: false };
  }
  if (name === "auth_login") {
    if (!provider.auth?.oauth) throw Error("OAuth no disponible");
    operation = new AbortController();
    const controller = operation;
    try {
      const deviceId = await installationId();
      await r.login(
        p.provider,
        "oauth",
        {
          signal: controller.signal,
          notify(e) {
            if (e.type === "auth_url")
              send({
                event: "auth",
                data: {
                  url: e.url,
                  message: "Abre la página para autorizar el proveedor.",
                },
              });
            else if (e.type === "device_code")
              send({
                event: "auth",
                data: {
                  url: e.verificationUri,
                  message: "Código de dispositivo: " + e.userCode,
                },
              });
            else progress("Autenticación en curso");
          },
          prompt(p) {
            return new Promise((resolve, reject) => {
              inputPrompt = { resolve, reject };
              send({
                event: "auth",
                data: {
                  inputRequired: true,
                  message:
                    p.type === "select"
                      ? "Escribe el identificador de una opción: " +
                        p.options.map((x) => x.id).join(", ")
                      : "Completa la autorización e introduce el código o URL de retorno.",
                },
              });
              p.signal?.addEventListener(
                "abort",
                () => {
                  inputPrompt = undefined;
                  reject(Error("Cancelado"));
                },
                { once: true },
              );
            });
          },
        },
        { getDeviceId: () => deviceId, agentName: "DevGuard" },
      );
      runtime = undefined;
      return { authenticated: true };
    } finally {
      operation = undefined;
      inputPrompt = undefined;
    }
  }
  throw Error("Método no autorizado");
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > 2 * 1024 * 1024) {
    process.exit(1);
  }
  let pos;
  while ((pos = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, pos);
    buffer = buffer.slice(pos + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.exit(1);
    }
    if (frame.toolResultId) {
      pending.get(frame.toolResultId)?.(frame);
      continue;
    }
    if (typeof frame.id !== "string" || typeof frame.method !== "string")
      continue;
    Promise.resolve()
      .then(() => method(frame.method, frame.params ?? {}))
      .then((value) => send({ id: frame.id, result: value }))
      .catch(() =>
        send({
          id: frame.id,
          error:
            "No se pudo completar la operación de Pi. Revisa autenticación, modelo y permisos.",
        }),
      );
  }
});
process.stdin.on("end", () => {
  operation?.abort();
  session?.dispose();
  process.exit(0);
});
