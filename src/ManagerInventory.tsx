import { useId, useState } from "react";
import "./ManagerInventory.css";

type InstalledPackage = { name: string; version: string; kind: string };
export type ManagerInventory = {
  id: "homebrew" | "npm" | "python";
  name: string;
  status: "ok" | "error" | "not_found";
  source: string | null;
  packages: InstalledPackage[];
  detail: string;
};
const PAGE_SIZE = 100;

export default function ManagerPackages({ inventory }: { inventory: ManagerInventory }) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const filterId = useId();
  const query = filter.trim().toLocaleLowerCase("es");
  const filtered = inventory.packages.filter((item) =>
    `${item.name} ${item.version} ${item.kind}`
      .toLocaleLowerCase("es")
      .includes(query),
  );
  const visible = filtered.slice(0, limit);
  const status =
    inventory.status === "ok"
      ? `${inventory.packages.length} ${inventory.packages.length === 1 ? "paquete" : "paquetes"}`
      : inventory.status === "not_found"
        ? "No encontrado"
        : "Error de consulta";

  return (
    <details className={`manager-group manager-${inventory.status}`}>
      <summary>
        <span className="manager-chevron" aria-hidden="true">
          ›
        </span>
        <span className="manager-name">{inventory.id === "npm" ? "Paquetes globales (npm)" : inventory.id === "python" ? "Bibliotecas (pip)" : "Paquetes y aplicaciones"}</span>
        <span className="manager-status">{status}</span>
      </summary>
      <div className="manager-content">
        <dl className="manager-origin">
          <dt>Origen</dt>
          <dd>
            {inventory.source ? (
              <code>{inventory.source}</code>
            ) : (
              "No disponible"
            )}
          </dd>
        </dl>
        <p className="manager-detail">{inventory.detail}</p>
        {inventory.packages.length > 0 && (
          <>
            <div className="manager-filter-row">
              <label htmlFor={filterId}>Filtrar paquetes</label>
              <input
                id={filterId}
                type="search"
                value={filter}
                placeholder="Nombre, versión o tipo"
                onChange={(event) => {
                  setFilter(event.currentTarget.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            </div>
            <p className="manager-count" role="status">
              Mostrando {visible.length} de {filtered.length}
              {query
                ? ` coincidencias · ${inventory.packages.length} en total`
                : " paquetes"}
              .
            </p>
            {filtered.length === 0 ? (
              <p className="manager-empty-filter">
                No hay paquetes que coincidan con el filtro.
              </p>
            ) : (
              <>
                <div
                  className="manager-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={`Paquetes de ${inventory.name}`}
                >
                  <table className="manager-table">
                    <caption>
                      Paquetes reportados por {inventory.name}. Las versiones
                      instaladas no indican su estado de seguridad.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Paquete</th>
                        <th scope="col">Versión instalada</th>
                        <th scope="col">Tipo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item, index) => (
                        <tr
                          key={`${item.name}:${item.version}:${item.kind}:${index}`}
                        >
                          <th scope="row">{item.name}</th>
                          <td>
                            <code>{item.version || "No disponible"}</code>
                          </td>
                          <td>{item.kind || "No disponible"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {limit < filtered.length && (
                  <button
                    className="manager-more-button"
                    type="button"
                    onClick={() => setLimit((current) => current + PAGE_SIZE)}
                  >
                    Mostrar {Math.min(PAGE_SIZE, filtered.length - limit)} más
                  </button>
                )}
              </>
            )}
          </>
        )}
        {inventory.status === "ok" && inventory.packages.length === 0 && (
          <p className="manager-empty-filter">
            El gestor no reportó paquetes instalados en este origen.
          </p>
        )}
      </div>
    </details>
  );
}
