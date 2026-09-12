import { describe, expect, it } from "vitest";

import { extrairEntradaEParcelas, type TabelaComFluxoBruta } from "./fluxo-de-pagamento";

// Fixture REAL — GET em produção (JBA, tabela 197, 2026-09-12). Reduzida aos
// campos que a função lê; os campos não usados (uuid, pmt, timestamps etc.)
// foram omitidos de propósito, não por desconhecimento.
const TABELA_197_REAL: TabelaComFluxoBruta = {
  monthly_rate: "0.79",
  sales_table_flow: [
    {
      sales_table_item: [
        { name: "Entrada", percent: "6.6666666666667", parcel_type: "signal", quota: 1 },
        { name: "Entrada", percent: "6.6666666666667", parcel_type: "signal", quota: 1 },
        { name: "Entrada", percent: "6.6666666666667", parcel_type: "signal", quota: 1 },
        { name: "Mensal", percent: "80", parcel_type: "monthly", quota: 60 },
      ],
    },
  ],
};

describe("extrairEntradaEParcelas", () => {
  it("soma os itens 'signal' em entrada.percentual (fixture real: 3x 6,6667% = 20%)", () => {
    const { entrada } = extrairEntradaEParcelas(TABELA_197_REAL);
    expect(entrada).not.toBeNull();
    expect(entrada!.percentual).toBeCloseTo(20, 5);
  });

  it("usa o item 'monthly' para quantidade de parcelas (fixture real: 60x)", () => {
    const { parcelas } = extrairEntradaEParcelas(TABELA_197_REAL);
    expect(parcelas).toEqual({ quantidade: 60, taxaMensal: 0.79 });
  });

  it("tabela sem sales_table_flow devolve entrada/parcelas null (nunca inventa)", () => {
    expect(extrairEntradaEParcelas({ monthly_rate: "0" })).toEqual({ entrada: null, parcelas: null });
  });

  it("ignora parcel_type desconhecido (não classifica em entrada nem em parcelas)", () => {
    const comTipoDesconhecido: TabelaComFluxoBruta = {
      monthly_rate: "0",
      sales_table_flow: [
        {
          sales_table_item: [{ name: "Balão", percent: "10", parcel_type: "balloon", quota: 1 }],
        },
      ],
    };
    expect(extrairEntradaEParcelas(comTipoDesconhecido)).toEqual({ entrada: null, parcelas: null });
  });

  it("tabela sem monthly_rate mas com parcela mensal: taxaMensal null, quantidade preservada", () => {
    const semTaxa: TabelaComFluxoBruta = {
      sales_table_flow: [
        { sales_table_item: [{ name: "Mensal", percent: "100", parcel_type: "monthly", quota: 48 }] },
      ],
    };
    expect(extrairEntradaEParcelas(semTaxa)).toEqual({ entrada: null, parcelas: { quantidade: 48, taxaMensal: null } });
  });
});
