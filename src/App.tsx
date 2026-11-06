import { Button } from "@/components/ui/button";
import { useState } from "react";
import "./App.css";
import PiAgentPanel from "./PiAgentPanel";
import RepositoryDashboard from "./RepositoryDashboard";
function Shield({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3 20 6v6c0 4-4.5 7.5-8 9-3.5-1.5-8-5-8-9V6l8-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m8.5 12 2.3 2.3 4.7-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState<"repositories" | "settings">("repositories");
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="DevGuard">
        <div className="brand">
          <span className="brand-icon">
            <Shield />
          </span>
          <span>DevGuard</span>
        </div>
        <nav className="section-nav" aria-label="Secciones">
          {(
            [
              { id: "repositories", label: "Repositorios" },
              { id: "settings", label: "Configuración IA" },
            ] as const
          ).map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              className="section-link h-auto justify-start"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              {item.label}
              {view === item.id && (
                <span className="section-dot" aria-hidden="true" />
              )}
            </Button>
          ))}
        </nav>
      </aside>
      <main>
        <div className="main-content">
          <div hidden={view !== "repositories"}>
            <RepositoryDashboard onSettings={() => setView("settings")} />
          </div>
          <div hidden={view !== "settings"}>
            <PiAgentPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
