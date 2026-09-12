/**
 * Detalhe de entrada/parcelas de uma tabela do Facilita, extraído de
 * `salestable/flow` (comprovado por GET real em 2026-09-12, tabela 197 do
 * JBA: `sales_table_flow[0].sales_table_item[]`, cada item com `percent`,
 * `parcel_type` e `quota`).
 *
 * Só dois `parcel_type` têm semântica comprovada nesta instância:
 *   - "signal"  → entrada (soma dos `percent` de todos os itens desse tipo);
 *   - "monthly" → parcela mensal (quantidade = `quota`).
 * Qualquer outro `parcel_type` (ex.: balão, financiamento) é IGNORADO aqui —
 * não inventamos semântica para o que não vimos em dado real. Ele
 * simplesmente não entra em `entrada`/`parcelas`, em vez de ser mal
 * classificado num dos dois grupos.
 *
 * A taxa mensal vem do campo `monthly_rate` da PRÓPRIA tabela (mesmo nível
 * de `sales_table_flow`, não do item) — já comprovado presente em toda
 * tabela vista (ex.: "0.79" para a tabela 197).
 *
 * `pmt` (valor em R$ de cada parcela) que a API devolve NÃO é usado aqui: ele
 * é calculado pelo Facilita contra um custo de REFERÊNCIA da tabela (não o
 * custo do lote específico que o lead perguntou) — usá-lo verbatim para um
 * lote de preço diferente citaria um valor errado. Quem precisar do valor em
 * R$ de uma parcela para um LOTE específico deve calcular
 * `percentual/100 * custoDoLote` no chamador, nunca ler `pmt` direto.
 */

export interface ItemDeFluxoBruto {
  name: string;
  percent: string | number;
  parcel_type: string;
  quota: number;
}

export interface FluxoBruto {
  sales_table_item: ItemDeFluxoBruto[];
}

export interface TabelaComFluxoBruta {
  monthly_rate?: string | number | null;
  sales_table_flow?: FluxoBruto[];
}

export interface DetalheDeEntradaEParcelas {
  entrada: { percentual: number } | null;
  parcelas: { quantidade: number; taxaMensal: number | null } | null;
}

const SEM_DETALHE: DetalheDeEntradaEParcelas = { entrada: null, parcelas: null };

export function extrairEntradaEParcelas(tabela: TabelaComFluxoBruta): DetalheDeEntradaEParcelas {
  const fluxo = tabela.sales_table_flow?.[0];
  if (!fluxo) return SEM_DETALHE;

  const itensDeEntrada = fluxo.sales_table_item.filter((item) => item.parcel_type === "signal");
  const percentualEntrada = itensDeEntrada.reduce((soma, item) => soma + Number(item.percent), 0);
  const entrada =
    itensDeEntrada.length > 0 && Number.isFinite(percentualEntrada) ? { percentual: percentualEntrada } : null;

  const itemMensal = fluxo.sales_table_item.find((item) => item.parcel_type === "monthly");
  let taxaMensal: number | null = null;
  if (tabela.monthly_rate !== undefined && tabela.monthly_rate !== null) {
    const valor = Number(tabela.monthly_rate);
    taxaMensal = Number.isFinite(valor) ? valor : null;
  }
  const parcelas = itemMensal ? { quantidade: itemMensal.quota, taxaMensal } : null;

  return { entrada, parcelas };
}
