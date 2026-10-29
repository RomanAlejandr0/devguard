import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./SkillInstructions.css";

type Props = { id: string; name: string };
export default function SkillInstructions({id,name}: Props) {
  const [text,setText]=useState<string | null>(null);
  const [error,setError]=useState(false);
  const [loading,setLoading]=useState(false);
  const inFlight=useRef(false);
  async function load() {
    if(inFlight.current || text !== null) return;
    if(!isTauri()){setError(true);return;}
    inFlight.current=true;setLoading(true);setError(false);
    try {
      const result=await invoke<{id:string;instructions:string}>("pi_request",{method:"skill_read",params:{id}});
      setText(result.instructions);
    } catch {setError(true);}
    finally {inFlight.current=false;setLoading(false);}
  }
  return (
    <details className="skill-instructions" onToggle={(event)=>{if(event.currentTarget.open)void load();}}>
      <summary>Ver instrucciones · {name}</summary>
      <div>
        <p>Solo lectura · Texto de la skill incluida en esta versión de DevGuard.</p>
        {loading && <p role="status">Cargando instrucciones…</p>}
        {error && <p role="alert">No se pudieron cargar las instrucciones. <button type="button" onClick={()=>void load()}>Reintentar</button></p>}
        {text !== null && <pre tabIndex={0} aria-label={`Instrucciones de ${name}, solo lectura`}>{text}</pre>}
      </div>
    </details>
  );
}
