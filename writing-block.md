# DevGuard
**Monitor inteligente de seguridad para desarrolladores**

**Tipo:** Aplicación de escritorio, open source  
**Plataforma inicial:** macOS  
**Tecnologías:** Tauri 2, React, TypeScript y Rust

## 1. Descripción

DevGuard es una aplicación de escritorio que centraliza el monitoreo de seguridad de herramientas, dependencias y aplicaciones utilizadas por desarrolladores.

Su propósito es detectar vulnerabilidades conocidas, versiones desactualizadas y software sin soporte, evaluar su relevancia y recomendar acciones para reducir riesgos.

A diferencia de un antivirus tradicional, DevGuard se enfoca en la seguridad del entorno de desarrollo y en comprender cómo afectan las vulnerabilidades a cada usuario.

## 2. Funcionalidades principales

- **Inventario automático:** detectar herramientas instaladas como Node.js, Python y Homebrew, incluyendo sus versiones.
- **Análisis de dependencias:** identificar paquetes vulnerables en proyectos locales.
- **Detección de vulnerabilidades:** consultar bases de datos como OSV y fuentes oficiales de seguridad.
- **Priorización de riesgos:** clasificar hallazgos según gravedad, exposición, explotación conocida y contexto.
- **Software sin soporte:** identificar versiones y aplicaciones que ya no reciben actualizaciones de seguridad.
- **Dashboard centralizado:** mostrar el estado general de seguridad, vulnerabilidades y acciones recomendadas.
- **Monitoreo periódico:** realizar escaneos programados y detectar nuevos riesgos.
- **Historial:** registrar vulnerabilidades detectadas, corregidas y pendientes.

## 3. Inteligencia artificial

DevGuard podrá integrar opcionalmente modelos de inteligencia artificial para:

- Investigar vulnerabilidades y consultar información oficial.
- Evaluar si una vulnerabilidad podría afectar realmente al usuario.
- Explicar riesgos en lenguaje sencillo.
- Recomendar actualizaciones y analizar posibles incompatibilidades.
- Preparar planes de corrección ordenados por prioridad.

La detección básica funcionará sin inteligencia artificial. Los modelos actuarán como una capa adicional de investigación y asistencia, sin sustituir las fuentes verificables.

## 4. Arquitectura tecnológica

| Componente | Tecnología |
|---|---|
| Aplicación de escritorio | Tauri 2 |
| Interfaz y dashboard | React + TypeScript |
| Backend y escáner local | Rust |
| Almacenamiento local | SQLite |
| Vulnerabilidades conocidas | OSV y fuentes oficiales |
| Inteligencia artificial | Proveedor configurable |

La arquitectura será modular para permitir nuevas integraciones sin reconstruir la aplicación.

Se priorizará el procesamiento local, los permisos mínimos y la privacidad del usuario.

## 5. Primera versión (MVP)

El desarrollo comenzará con una aplicación para macOS que permita:

1. Detectar instalaciones y versiones de Node.js, Python y Homebrew.
2. Analizar dependencias de proyectos locales seleccionados.
3. Consultar vulnerabilidades conocidas mediante OSV.
4. Presentar resultados en un dashboard con prioridades y recomendaciones.
5. Ejecutar nuevos escaneos manualmente.

El objetivo inicial es obtener un diagnóstico útil y verificable del entorno de desarrollo sin requerir cuentas ni servicios de pago.

## 6. Funcionalidades futuras

- Integración con repositorios de GitHub.
- Análisis de contenedores Docker.
- Conexión con servidores y aplicaciones desplegadas.
- Compatibilidad con Windows y Linux.
- Agente de IA para investigación y mantenimiento asistido.
- Alertas automáticas y notificaciones.
- Ecosistema de conectores desarrollados por la comunidad.
- **Self-Audit:** capacidad de DevGuard para analizar sus propias dependencias, integridad y estado de seguridad.

## 7. Diferenciación

DevGuard no pretende reemplazar antivirus ni escáneres de vulnerabilidades existentes.

Su propuesta es **unificar herramientas de seguridad, contextualizar sus hallazgos y ayudar a resolverlos desde una sola interfaz**.

Sus principios son:

- Open source y gratuito en sus funciones esenciales.
- Funcionamiento local y sin necesidad de crear una cuenta.
- Seguridad especializada en desarrolladores.
- Priorización contextual, no solamente por severidad.
- Inteligencia artificial opcional.
- Recomendaciones comprensibles y respaldadas por evidencia.
- Control del usuario sobre cualquier modificación del sistema.

## 8. Visión

Convertir DevGuard en un centro de control de seguridad personal para desarrolladores, capaz de supervisar progresivamente computadoras, proyectos, repositorios, contenedores y aplicaciones desplegadas.

**Objetivo central:** que el desarrollador no tenga que investigar constantemente qué vulnerabilidades nuevas podrían afectarlo, sino que DevGuard identifique los riesgos relevantes y le ayude a decidir qué corregir primero.