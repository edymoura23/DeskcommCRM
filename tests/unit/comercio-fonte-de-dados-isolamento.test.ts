import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * VARREDURA: toda consulta a `commercial_data_sources` precisa filtrar
 * `organization_id` E `is_active` na MESMA cadeia.
 *
 * Mesmo molde de `tests/unit/canal-consulta-por-organizacao.test.ts` (issue
 * #236): `commercial_data_sources` é lida com o client de service role
 * (`ctx.supabase` do MCP, que BYPASSA RLS) — a proteção real é o filtro
 * explícito no código, não a RLS sozinha. `organization_id` nunca pode vir
 * do input do chamador (resolvido de `ctx.organizationId`, fonte confiável);
 * `is_active` é o mesmo recorte do índice único
 * `commercial_data_sources_org_provider_ativo_unique` — consulta que não usa
 * o mesmo recorte lê um conjunto maior do que o que o banco garante único.
 */
const RAIZ = process.cwd();
const DIR = path.join(RAIZ, "lib/comercio");

function arquivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosTs(p);
    return e.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

interface Consulta {
  arquivo: string;
  linha: number;
  filtros: string[];
}

/** `.eq("x", …)`, `.is("x", …)` → nome da coluna filtrada. */
function colunasFiltradas(trecho: string): string[] {
  return [...trecho.matchAll(/\.(?:eq|is|in|neq|match)\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

function consultas(fonte: string, arquivo: string): Consulta[] {
  const out: Consulta[] = [];
  const marca = '.from("commercial_data_sources")';
  let i = fonte.indexOf(marca);
  while (i !== -1) {
    const fim = fonte.indexOf(";", i);
    const cadeia = fonte.slice(i, fim === -1 ? fonte.length : fim);
    out.push({
      arquivo: path.relative(RAIZ, arquivo),
      linha: fonte.slice(0, i).split("\n").length,
      filtros: colunasFiltradas(cadeia),
    });
    i = fonte.indexOf(marca, i + marca.length);
  }
  return out;
}

const TODAS = arquivosTs(DIR).flatMap((a) => consultas(fs.readFileSync(a, "utf8"), a));

describe("lib/comercio: consulta a commercial_data_sources sempre por organization_id", () => {
  it("a varredura enxerga alguma consulta (senão ela mede o vazio)", () => {
    // Controle do instrumento — sem isto, mover o arquivo, renomear a tabela
    // ou quebrar o extrator deixaria o gate VERDE por não medir nada.
    expect(TODAS.length).toBeGreaterThanOrEqual(1);
  });

  it("toda consulta filtra organization_id na mesma cadeia", () => {
    const faltando = TODAS.filter((c) => !c.filtros.includes("organization_id")).map(
      (c) => `${c.arquivo}:${c.linha} (filtros: ${c.filtros.join(", ") || "nenhum"})`,
    );

    expect(
      faltando,
      "commercial_data_sources é lida com service role (bypassa RLS) — toda consulta " +
        "PRECISA filtrar organization_id explicitamente, resolvido de fonte confiável " +
        "(ctx.organizationId), NUNCA do input do chamador.",
    ).toEqual([]);
  });

  it("toda consulta filtra is_active (mesmo recorte do índice único)", () => {
    const faltando = TODAS.filter((c) => !c.filtros.includes("is_active")).map(
      (c) => `${c.arquivo}:${c.linha} (filtros: ${c.filtros.join(", ") || "nenhum"})`,
    );

    expect(
      faltando,
      "Filtre is_active=true: é o MESMO recorte do índice único " +
        "commercial_data_sources_org_provider_ativo_unique (migration 0206).",
    ).toEqual([]);
  });
});
