import { describe, expect, it } from "vitest";

import { precoDeReferencia, type UnidadeFacilitaBruta } from "./preco-de-referencia";

describe("precoDeReferencia", () => {
  it("usa cost como referência de preço", () => {
    const unidade: UnidadeFacilitaBruta = {
      cost: "363000.00",
      sale_price: null,
      block: "01",
      number: "1",
      situation: "available",
    };
    expect(precoDeReferencia(unidade)).toEqual({ valorReferencia: 363000, quadra: "01", lote: "1" });
  });

  // Números reais comprovados por GET em produção (JBA, 2026-09-11): unidade
  // 10634, cost=291500, sale_price=265000 (vendida, desconto negociado).
  it("NUNCA expõe sale_price no retorno, mesmo quando populado e diferente de cost", () => {
    const unidadeVendida: UnidadeFacilitaBruta = {
      cost: "291500.00",
      sale_price: "265000.00",
      block: "01",
      number: "19",
      situation: "sale",
    };
    const resultado = precoDeReferencia(unidadeVendida);

    expect(resultado).not.toBeNull();
    expect(Object.keys(resultado as object)).not.toContain("sale_price");
    // Não é só ausência de CHAVE: o VALOR de sale_price também não pode
    // aparecer em lugar nenhum do objeto de saída.
    expect(JSON.stringify(resultado)).not.toContain("265000");
    expect(resultado?.valorReferencia).toBe(291500);
  });

  it("retorna null quando cost está ausente, em vez de inventar preço", () => {
    const unidade: UnidadeFacilitaBruta = { cost: null, sale_price: null, block: "01", number: "1", situation: "available" };
    expect(precoDeReferencia(unidade)).toBeNull();
  });

  it("retorna null quando cost não é um número válido", () => {
    const unidade: UnidadeFacilitaBruta = {
      cost: "não-é-numero" as unknown as string,
      block: "01",
      number: "1",
      situation: "available",
    };
    expect(precoDeReferencia(unidade)).toBeNull();
  });
});
