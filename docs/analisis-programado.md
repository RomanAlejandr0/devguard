# Análisis periódico de repositorios: investigación y propuesta

Investigación del 2 de noviembre de 2026. Es una propuesta para DevGuard: todavía no se han implementado ni activado tareas periódicas.

## Qué hace Hermes

Se descargó el repositorio oficial [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), en el commit `5e7c2b254d414e4e25105231f818f385fee67469`. Se inspeccionó su código; no se instaló ni ejecutó Hermes.

Su programación separa el disparador del trabajo del agente:

1. Guarda definiciones de tareas por perfil en `cron/jobs.json`: programación, estado, configuración y próximo vencimiento. Usa bloqueos y escritura mediante archivo temporal para proteger los cambios. Código: [jobs.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/jobs.py).
2. El proveedor local comprueba vencimientos cada 60 segundos por defecto. El supervisor mantiene vivo el ticker y hay controles para evitar disparos duplicados y solapamientos. Código: [scheduler_provider.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler_provider.py), [scheduler_tick.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler_tick.py), [scheduler_thread.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler_thread.py).
3. Cada ejecución usa una sesión de agente propia, con modelo, herramientas y skills. La ruta actual centraliza los trabajos de agente en el gateway: un tick aislado no levanta por sí mismo ese gateway. Código: [scheduler.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler.py), [scheduler_authority.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler_authority.py).
4. Separa programación de historial: las ejecuciones se registran en `executions.db`, los resultados en archivos por tarea/fecha y el estado breve de continuidad en `notepad.db`. Código: [executions.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/executions.py), [notepad.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/notepad.py).
5. La continuidad es explícita. Puede incorporar el último resultado de la misma tarea (`continuity`, internamente `context_from: ["self"]`) y mantener cursores, sin reutilizar indefinidamente una conversación. También dispone de comparación de resultados para monitores. Código: [scheduler_prompt.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/scheduler_prompt.py), [monitor.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/monitor.py).

`parse_schedule` admite intervalos como `every 24h` y `every 48h`, además de expresiones cron. Para intervalos suma duración en UTC; para horarios de calendario admite zona IANA por tarea. «Cada 48 horas» conviene expresarlo como intervalo; `*/2` en el día del mes no representa una cadencia uniforme de 48 horas entre meses. Véanse [jobs.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/jobs.py) y [jobs_time.py](https://github.com/NousResearch/hermes-agent/blob/5e7c2b254d414e4e25105231f818f385fee67469/cron/jobs_time.py).

Referencia general: [documentación oficial de tareas programadas](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

## Aplicación propuesta a DevGuard

Reutilizar Pi y la cadena actual; no incorporar otro agente ni arrancar Hermes desde DevGuard. El reloj y la cola son código del programa, no decisiones del modelo.

- **Interfaz:** en el detalle de cada repositorio, una opción «Manual / Cada día / Cada 2 días», próximo análisis y un control para pausar. Mantener las tarjetas actuales.
- **Definición:** `jobs.json` privado y versionado con `repositoryId`, ruta autorizada, `intervalHours` (24 o 48), `nextRunAt`, `enabled`, proveedor, modelo y versión de skill/política. Nunca incluir credenciales.
- **Ejecución:** un trabajo activo por repositorio y, inicialmente, un análisis global a la vez, compatible con el sidecar actual. Bloquear duplicados, limitar tiempo y consumo, permitir cancelar y registrar errores. Ante un reinicio o suspensión, agrupar los vencimientos atrasados en una sola revisión pendiente, no ejecutar todos en ráfaga.
- **Resultado:** conservar el último informe de la tarjeta y añadir `runs/<repositoryId>/<runId>.json`. El almacén actual reemplaza el informe anterior y por eso aún no basta para comparar días.
- **Continuidad:** guardar identificadores estables de hallazgos y una lista de archivos pendientes. Comparar nuevos, persistentes y corregidos. La continuidad debe venir de datos validados; los fragmentos de código y los informes anteriores no se convierten en instrucciones confiables del sistema.
- **Coste:** reutilizar arquitectura e inventario si no cambiaron los archivos, la skill ni la política; consultar OSV de nuevo aunque el repositorio no cambie, porque pueden publicarse avisos nuevos. Dejar explícita la fecha de cada fuente y qué etapas se reutilizaron.
- **Permisos:** continuar en solo lectura. El modelo no puede crear sus propios horarios, cambiar proveedor o concederse herramientas. Un archivo AGENTS.md no puede programar nada ni ampliar permisos.

Para la primera entrega, el planificador puede vivir en Tauri mientras DevGuard está abierto. Para trabajar con la ventana cerrada se necesita un ejecutor de fondo y, en macOS, integrar un LaunchAgent; un temporizador de React o del sidecar que Tauri cierra al salir no resuelve ese caso. El Mac apagado no ejecuta análisis locales. No se ha creado ningún servicio ni horario en esta investigación.

## Hallazgo práctico de cobertura

Hermes ya se añadió desde DevGuard y la cadena terminó con tarjeta **naranja**. La revisión leyó 45 de 105 archivos disponibles en su instantánea y el lector informó 9609 entradas omitidas. Los manifiestos principales no estuvieron disponibles para el agente: devolvió cero paquetes verificables y cero consultas OSV. Esto no significa que Hermes no tenga dependencias ni vulnerabilidades; el análisis es parcial y no ofrece un inventario suficiente para evaluarlo.

Antes de programar revisiones grandes conviene reemplazar la instantánea única por un índice paginado y lecturas bajo demanda, priorizando manifiestos/locks, puntos de entrada e instrucciones para agentes. Los límites deben conservarse, pero el agente necesita un cursor y una lista verificable de lo que queda pendiente. Aumentar el presupuesto sin priorización no demuestra cobertura. Es una mejora propuesta, no aplicada en esta entrega.

## Otras revisiones de seguridad para el agente

Las siguientes son categorías candidatas, no vulnerabilidades confirmadas en Hermes.

| Prioridad | Revisión | Evidencia que debe exigir |
|---|---|---|
| 1 | Secretos publicables o ya versionados | Archivos seguidos por Git, cambios preparados e historial cuando se autorice. `.gitignore` no elimina lo ya seguido. Enmascarar los valores antes de enviarlos al modelo y no probar credenciales contra servicios. |
| 1 | Instalación y cadena de suministro | Scripts `preinstall`/`postinstall`, descargas que se ejecutan, referencias Git/URLs mutables, discrepancias de locks y componentes transitivos. Un nombre parecido a otro paquete es una sospecha, no prueba de malware. |
| 1 | CI/CD | Permisos de tokens, uso de secretos con contribuciones no confiables, `pull_request_target`, interpolación de títulos/ramas en shell y Actions fijadas a referencias mutables. |
| 2 | Autenticación y autorización | Ruta real desde la entrada hasta la operación protegida: propiedad del recurso, separación entre usuarios/organizaciones, rutas administrativas y verificación de sesiones/tokens. |
| 2 | Inyección y acceso a recursos | Datos externos que lleguen a SQL, shell, HTML, rutas de archivos o peticiones HTTP internas: SQL injection, command injection, XSS, path traversal y SSRF. Demostrar origen, flujo y controles ausentes. |
| 2 | Configuración y despliegue | Depuración habilitada, CORS permisivo, TLS desactivado, cookies sin protección, contenedores privilegiados y montajes peligrosos. Distinguir configuración de ejemplo de configuración realmente usada. |
| 2 | Agentes, MCP y memoria | Herramientas con permisos excesivos, exfiltración, cruces entre repositorios y persistencia de instrucciones en memoria, informes o tareas programadas. Verificar la autorización en el código que ejecuta herramientas, no solo en el prompt. |
| 3 | Criptografía y exposición de datos | Claves fijas, cifrado o aleatoriedad inadecuados y datos sensibles en logs o respuestas. Justificar el contexto y el impacto. |

Para cada hallazgo: archivo/línea, evidencia, flujo relevante, impacto, confianza y límites. Mantener aparte «vulnerabilidad confirmada», «sospecha» y «sin revisar». Un agente en solo lectura puede identificar candidatos; demostrar todos los comportamientos de ejecución requiere pruebas adicionales en un entorno aislado y autorizado.

Fuentes:

- [OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction/): controles de acceso, configuración, inyección, criptografía y cadena de suministro.
- [GitHub: uso seguro de Actions](https://docs.github.com/en/actions/reference/security/secure-use): permisos mínimos, código no confiable y dependencias de workflows.
- [GitHub: secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning): alcance del historial y tipos de credenciales.
- [OWASP: AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html): permisos de herramientas, memoria, contexto y protección de datos.

Orden recomendado: mejorar cobertura en repositorios grandes; añadir historial y ejecución periódica de la cadena existente; después incorporar secretos y CI/CD como skills acotadas.
