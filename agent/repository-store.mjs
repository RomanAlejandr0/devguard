import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
export function repositoryStore(dir) {
  const path = join(dir, "repositories.json");
  async function list() {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      if (data.schemaVersion !== 1 || !Array.isArray(data.repositories))
        throw Error("Formato de informes no compatible");
      return data.repositories;
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async function save(reports) {
    const temp = path + ".tmp";
    await writeFile(
      temp,
      JSON.stringify({ schemaVersion: 1, repositories: reports }, null, 2),
      { mode: 0o600 },
    );
    await rename(temp, path);
  }
  return {
    list,
    async put(report) {
      const all = await list();
      const index = all.findIndex((r) => r.id === report.id);
      if (index < 0) all.push(report);
      else all[index] = report;
      await save(all);
    },
    async remove(id) {
      await save((await list()).filter((r) => r.id !== id));
    },
  };
}
