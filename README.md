# DevGuard

Primer prototipo de una aplicación local para macOS que detecta **Node.js, Python y Homebrew** y muestra su versión, ubicación y resultado de detección.

## Alcance

- Detección manual con un botón, sin modificar las herramientas detectadas.
- Consultas locales y acotadas a ejecutables accesibles o ubicaciones habituales.
- Estados distintos para detectada, no encontrada y error de detección.
- Escaneo tradicional sin cuenta; análisis con IA opcional mediante Pi. Sin consultas de vulnerabilidades, actualizaciones automáticas ni telemetría.

Una herramienta detectada **no significa** que sea segura o esté actualizada. Tampoco se garantiza encontrar todas las instalaciones de nvm, pyenv u otros gestores. La aplicación no carga perfiles de shell ni instala herramientas. En macOS omite el lanzador `/usr/bin/python3` para evitar que una consulta dispare un instalador; sí consulta el ejecutable directo de Python incluido en Xcode o Command Line Tools cuando existe. El inventario de Python corresponde al intérprete accesible; no recorre entornos virtuales.

## Desarrollo

Requisitos: Node.js y pnpm, Rust estable y herramientas de desarrollo de Xcode.

```sh
pnpm install
pnpm tauri dev
```

Si Rust se instaló sin modificar tu perfil de shell, añade su carpeta a la sesión antes de iniciar:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
pnpm tauri dev
```

`pnpm dev` muestra únicamente la interfaz en el navegador: la detección requiere la aplicación de escritorio. No se muestran resultados simulados.

## Comprobaciones

```sh
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Estructura

- `src/`: interfaz React y TypeScript.
- `src-tauri/`: aplicación nativa Tauri 2 y detector en Rust.

El detector solo admite las tres consultas previstas. La interfaz no recibe una función para ejecutar comandos arbitrarios.

## Proyectos locales

La pestaña **Proyectos** usa Pi para listar los paquetes de varias carpetas Node, conservando la tabla de dependencias y versiones. Selecciona primero proveedor y modelo en **Configuración IA**; quedan guardados para los siguientes análisis. Agregar de nuevo la misma carpeta actualiza su informe sin duplicarla. **Quitar de la lista** no borra archivos. La lista y los informes se conservan durante la sesión de la aplicación.

El agente usa una herramienta Rust limitada a metadatos de `package.json` y `package-lock.json`; no recibe scripts ni código del proyecto. Pi genera la lista y una validación local exige que coincidan nombres, tipos, declaraciones y versiones resueltas, sin omisiones ni paquetes inventados. Si falta la conexión o falla el análisis, se informa del error; no hay sustitución silenciosa por el parser tradicional. Se puede cancelar. No se buscan secretos, aplicaciones ni vulnerabilidades.

Se verificó la lectura del proyecto de prueba original en el Escritorio, sin cambiar permisos de macOS. El estado inicial del botón del selector puede aparecer desactivado en la lectura de accesibilidad antes de que termine de actualizarse; no se confirmó un bloqueo persistente del Escritorio.

## Paquetes de Mi Mac

«Detectar herramientas» consulta las versiones y obtiene inventarios de la instalación accesible de cada gestor:

- Homebrew: fórmulas y aplicaciones cask con sus versiones instaladas.
- npm: paquetes globales directos de esa instalación de Node/npm.
- Python: paquetes visibles para pip en el intérprete encontrado. No recorre entornos virtuales ni todas las instalaciones de Python.

Los paquetes se despliegan dentro de la tarjeta de cada herramienta, sin una sección duplicada. Cada resultado conserva su origen. Un gestor ausente o una consulta fallida se muestran por separado; no se interpretan como un inventario vacío. Las consultas tienen límites de tiempo y salida, sin instalar, actualizar ni analizar vulnerabilidades.

## Agente opcional con Pi

El escaneo tradicional sigue funcionando sin cuenta ni IA. La pestaña **Agente IA** utiliza el SDK oficial `@earendil-works/pi-coding-agent` **1.4.0**, fijado en `agent/package-lock.json`.

### Ejecutar

Se requiere **Node.js 22 o posterior** instalado en el equipo (también para el `.app` compilado). El runtime Node no se distribuye dentro del bundle en esta primera integración. `pnpm tauri dev` y `pnpm tauri build --debug --bundles app` instalan automáticamente las dependencias aisladas de `agent/` antes de iniciar o empaquetar. `pnpm build` comprueba la interfaz; `pnpm agent:test` prueba la validación del informe.

En **Configuración IA**, carga el catálogo y elige proveedor/modelo. **Cambiar conexión** separa el acceso con cuenta/suscripción del acceso con clave API. Una credencial guardada aparece sin comprobar hasta que **Comprobar conexión** recibe una respuesta real del modelo. En **Agente IA** selecciona las skills e inicia o cancela el análisis. **Importar conexión de Pi** importa explícitamente la credencial del proveedor seleccionado desde `~/.pi/agent/auth.json` al almacenamiento privado de DevGuard, sin modificar la sesión original. La disponibilidad de modelos en el catálogo no garantiza acceso: lo confirma una solicitud completada. Las suscripciones solo se ofrecen cuando el proveedor del SDK declara OAuth para suscripción. Configuraciones cloud que requieren datos adicionales o modelos/endpoints personalizados no tienen todavía un editor propio en el panel.

Las credenciales quedan en el directorio de datos de la aplicación, subcarpeta `pi/`, fuera del repositorio, con permisos privados. No se devuelven al dashboard. Son archivos administrados por Pi, no una promesa de cifrado por Keychain. La inferencia envía las observaciones de las skills seleccionadas al proveedor elegido; el panel lo indica antes de iniciar.

### Arquitectura y extensión

- React solo usa comandos de Tauri y eventos de progreso; no importa el SDK.
- `src-tauri/src/pi.rs` supervisa un proceso Node persistente con protocolo JSON por stdin/stdout, límites de mensajes, cancelación y cierre al salir.
- `agent/sidecar.mjs` configura una sesión Pi en memoria, sin descubrimiento de extensiones, archivos AGENTS, prompts o configuraciones de proyectos. No habilita las herramientas bash, read, edit o write de Pi.
- `agent/tools/registry.mjs` asigna cada skill a una herramienta de Rust permitida. El puente solo admite detección de herramientas e inventario de paquetes. El modelo no puede elegir rutas ni enviar comandos de terminal.
- `agent/skills/*/SKILL.md` contiene instrucciones de clasificación para herramientas y paquetes. Se pueden añadir skills y entradas al registro sin cambiar el bucle del agente; una herramienta nativa nueva requiere su autorización explícita en el puente Rust.
- `agent/report.mjs` exige resultados estructurados con nombres presentes en las observaciones y fuentes reconocidas. La evidencia visible se extrae del registro local correspondiente; la clasificación y el resumen siguen siendo interpretación del modelo. No se consultan vulnerabilidades ni se modifican instalaciones.

El inventario de Python corresponde al intérprete accesible y el de npm a paquetes globales. Cancelar detiene la inferencia; una consulta local ya iniciada puede terminar dentro de su límite de tiempo.

Referencias oficiales: [Pi SDK](https://pi.dev/docs/latest/sdk), [proveedores y autenticación](https://pi.dev/docs/latest/providers). La integración toma las firmas de las declaraciones y del ejemplo `examples/sdk/12-full-control.ts` incluidos en el paquete fijado.

El flujo de Proyectos utiliza la skill `agent/skills/project-packages/SKILL.md` y devuelve el mismo contrato de la tabla. Los lectores locales siguen siendo necesarios para acceder a archivos; el modelo no tiene terminal ni acceso libre al equipo. El inventario de Mi Mac mantiene su detección tradicional.

Cada skill se puede consultar en modo de solo lectura mediante **Ver instrucciones** en el lugar donde se utiliza: en Proyectos para `project-packages` y junto a cada skill de Agente IA para `tools` y `packages`. La vista carga el archivo incluido en la aplicación y no ofrece edición ni acceso a rutas arbitrarias.
