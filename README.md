# DevGuard

Primer prototipo de una aplicación local para macOS que detecta **Node.js, Python y Homebrew** y muestra su versión, ubicación y resultado de detección. También permite elegir la carpeta local de un proyecto Node y consultar sus dependencias directas.

## Alcance

- Detección manual con un botón, sin modificar las herramientas detectadas.
- Consultas locales y acotadas a ejecutables accesibles o ubicaciones habituales.
- Estados distintos para detectada, no encontrada y error de detección.
- Sin cuenta, IA, consultas de vulnerabilidades, actualizaciones automáticas ni telemetría.

Una herramienta detectada **no significa** que sea segura o esté actualizada. Tampoco se garantiza encontrar todas las instalaciones de nvm, pyenv u otros gestores. La aplicación no carga perfiles de shell ni instala herramientas. En macOS omite el lanzador `/usr/bin/python3` para evitar que una consulta dispare un instalador; sí consulta el ejecutable directo de Python incluido en Xcode o Command Line Tools cuando existe. No enumera paquetes de Python ni entornos virtuales.

## Desarrollo

Requisitos: Node.js y npm, Rust estable y herramientas de desarrollo de Xcode.

```sh
npm install
npm run tauri dev
```

Si Rust se instaló sin modificar tu perfil de shell, añade su carpeta a la sesión antes de iniciar:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri dev
```

`npm run dev` muestra únicamente la interfaz en el navegador: la detección requiere la aplicación de escritorio. No se muestran resultados simulados.

## Comprobaciones

```sh
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Estructura

- `src/`: interfaz React y TypeScript.
- `src-tauri/`: aplicación nativa Tauri 2 y detector en Rust.

El detector solo admite las tres consultas previstas. La interfaz no recibe una función para ejecutar comandos arbitrarios.

## Proyectos Node

En **Elegir proyecto**, selecciona la carpeta que contiene `package.json`. DevGuard lee las dependencias de producción, desarrollo, opcionales y peer. Si existe un `package-lock.json` compatible (v2 o v3), muestra además las versiones resueltas que correspondan al manifiesto. Un archivo ausente, incompatible o desactualizado se comunica sin inventar versiones.

El análisis no ejecuta scripts, no instala ni actualiza paquetes, no consulta la red y no recorre `node_modules`. Las versiones del archivo de bloqueo no confirman la instalación real ni la seguridad de los paquetes. Python, monorepos/workspaces completos y otros gestores (yarn/pnpm) quedan fuera de esta entrega.

Hay una carpeta independiente de prueba junto al repositorio: `../devguard-prueba-node`. Contiene dos dependencias de producción (`ms`, `picocolors`) y una de desarrollo (`typescript`), con un archivo de bloqueo generado por npm. Se puede seleccionar desde el mismo flujo que cualquier otro proyecto Node.
