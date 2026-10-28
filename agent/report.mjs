export function validateReport(report, observations) {
  if (!report || typeof report.summary !== 'string' || report.summary.length > 12000 || !Array.isArray(report.findings) || report.findings.length > 200 || !Array.isArray(report.limitations)) throw Error('Informe inválido');
  for (const f of report.findings) {
    if (!['name','category','source','evidence'].every(k => typeof f[k] === 'string' && f[k].length > 0 && f[k].length <= 6000) || !Array.isArray(f.limitations)) throw Error('Hallazgo inválido');
    const observation = observations.get(f.source);
    if (!observation || !JSON.stringify(observation).toLowerCase().includes(f.name.toLowerCase())) throw Error('El hallazgo no coincide con su fuente');
    const find = value => {
      if (!value || typeof value !== 'object') return null;
      if (value.name === f.name) return value;
      for (const child of Object.values(value)) { const match = find(child); if(match) return match; }
      return null;
    };
    const fact = find(observation);
    if (!fact) throw Error('Nombre sin registro verificable');
    f.evidence = JSON.stringify(fact).slice(0,6000);
    if (!f.limitations.every(v=>typeof v==='string' && v.length<=4000)) throw Error('Limitaciones inválidas');
  }
  if (!report.limitations.every(v=>typeof v==='string' && v.length<=4000)) throw Error('Limitaciones inválidas');
  return {...report, limitations: [...report.limitations,'La clasificación es una interpretación de IA. Las fuentes son observaciones locales; no es un análisis de vulnerabilidades.']};
}
