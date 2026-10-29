const groups = {dependencies:'production',devDependencies:'development',optionalDependencies:'optional',peerDependencies:'peer'};
export function validateProjectPackages(output, input) {
  if (!output || !Array.isArray(output.dependencies)) throw Error('Devuelve dependencies como una lista.');
  const expected = new Map();
  for (const [group,kind] of Object.entries(groups)) {
    for (const [name,declared] of Object.entries(input.manifest[group] ?? {})) expected.set(kind+':'+name,{name,kind,declared});
  }
  if (output.dependencies.length !== expected.size) throw Error('Incluye todas las dependencias directas, sin omitir ni añadir paquetes.');
  const seen = new Set();
  const lock = input.lock;
  const warnings = [...input.warnings];
  const supported = lock && [2,3].includes(lock.lockfileVersion) && lock.packages?.[''];
  let stale = false;
  const dependencies=output.dependencies.map(row=>{
    const key=row.kind+':'+row.name; const fact=expected.get(key);
    if(!fact || seen.has(key) || row.declared !== fact.declared) throw Error('Nombre, tipo o versión declarada no coinciden con el manifiesto.');
    seen.add(key);
    const group=Object.keys(groups).find(group=>groups[group]===row.kind);
    const rootMatches=supported && lock.packages[''][group]?.[row.name]===row.declared;
    if(supported&&!rootMatches)stale=true;
    const entry=lock?.packages?.['node_modules/'+row.name];
    const resolved=rootMatches&&!entry?.link&&typeof entry?.version==='string'?entry.version:null;
    if(row.resolved!==resolved) throw Error('La versión resuelta debe coincidir con packages[node_modules/nombre].version y con la declaración raíz; de lo contrario usa null.');
    return {...fact,resolved};
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.kind.localeCompare(b.kind));
  if(stale)warnings.push('Algunas declaraciones no coinciden con package-lock.json; se muestran sin versión resuelta.');
  return {name:input.name,path:input.path,lockfile:input.lockfile,warnings,dependencies};
}
