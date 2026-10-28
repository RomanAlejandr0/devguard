// Adding an instruction skill requires no changes to the session engine.
export const readers = {
  tools: { tool: 'detect_tools', description: 'Detectar versiones y ubicaciones de Node, Python y Homebrew.' },
  packages: { tool: 'collect_inventory', description: 'Inventariar paquetes Homebrew, npm global y pip del intérprete accesible.' },
};
