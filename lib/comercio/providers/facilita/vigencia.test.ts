import { describe, expect, it } from "vitest";

import { filtrarTabelasVigentes, type TabelaFacilitaBruta } from "./vigencia";

describe("filtrarTabelasVigentes", () => {
  const hoje = new Date("2026-09-11T00:00:00Z");

  it("exclui tabela com end_date no passado", () => {
    const tabelas: TabelaFacilitaBruta[] = [
      { id: 1, name: "expirada", start_date: "2022-01-01", end_date: "2023-01-31" },
    ];
    expect(filtrarTabelasVigentes(tabelas, hoje)).toEqual([]);
  });

  it("exclui tabela com start_date no futuro", () => {
    const tabelas: TabelaFacilitaBruta[] = [
      { id: 2, name: "futura", start_date: "2030-01-01", end_date: "2040-01-01" },
    ];
    expect(filtrarTabelasVigentes(tabelas, hoje)).toEqual([]);
  });

  it("inclui tabela vigente hoje", () => {
    const tabelas: TabelaFacilitaBruta[] = [
      { id: 3, name: "vigente", start_date: "2025-11-20", end_date: "2040-11-20" },
    ];
    expect(filtrarTabelasVigentes(tabelas, hoje).map((t) => t.id)).toEqual([3]);
  });

  it("trata start_date/end_date ausentes como sem limite", () => {
    const tabelas: TabelaFacilitaBruta[] = [{ id: 4, name: "sem limite", start_date: null, end_date: null }];
    expect(filtrarTabelasVigentes(tabelas, hoje)).toHaveLength(1);
  });

  // Fixture com os números REAIS comprovados por GET em produção (Atlântica
  // Clube, 2026-09-10): 4 tabelas vigentes (137-140) + 29 expiradas.
  it("fixture real: Atlântica Clube — 29 de 33 tabelas cadastradas estavam expiradas", () => {
    const vigentesReais: TabelaFacilitaBruta[] = [
      { id: 137, name: "Investidor 1 - Entrada 50% + 3x", start_date: "2024-09-21", end_date: "2030-09-23" },
      { id: 138, name: "Investidor 2 - Entrada 50% em 3x + 12x", start_date: "2024-09-21", end_date: "2030-09-21" },
      { id: 139, name: "Investidor 3 - Entrada 50% em 3x + 24x", start_date: "2024-09-21", end_date: "2030-09-21" },
      { id: 140, name: "Investidor 4 - Entrada 30% em 3x + 24x", start_date: "2024-09-21", end_date: "2030-09-21" },
    ];
    const expiradasReais: TabelaFacilitaBruta[] = Array.from({ length: 29 }, (_, i) => ({
      id: 2000 + i,
      name: `Entrada 3x+N (expirada ${i})`,
      start_date: "2022-12-15",
      end_date: "2023-01-31",
    }));

    const todas = [...vigentesReais, ...expiradasReais];
    const resultado = filtrarTabelasVigentes(todas, hoje);

    expect(resultado).toHaveLength(4);
    expect(resultado.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual([137, 138, 139, 140]);
  });
});
