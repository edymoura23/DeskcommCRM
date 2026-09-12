/**
 * Preço de referência de uma unidade do Facilita.
 *
 * `cost` é o preço de TABELA, presente em toda unidade disponível/reservada.
 * `sale_price` só existe em unidade já `situation='sale'` (vendida) e é o
 * valor REALIZADO daquele negócio já fechado — comprovado por GET real
 * (2026-09-11): em 30 unidades da amostra, `sale_price` era `null` nas 27
 * disponíveis/reservadas e só aparecia nas 3 vendidas, com valor DIFERENTE
 * do `cost` (às vezes menor — desconto negociado; às vezes maior — correção/
 * juros até o fechamento). Não é preço a citar a um lead novo.
 *
 * O tipo de retorno (`PrecoDeReferencia`, em `lib/comercio/tipos.ts`) não tem
 * campo de preço realizado — esta função só lê `sale_price` para nunca
 * repassá-lo adiante; não existe caminho de código para vazá-lo por engano.
 */
import type { PrecoDeReferencia } from "../../tipos";

export interface UnidadeFacilitaBruta {
  cost: string | number | null;
  /** Lido só para nunca ser repassado — ver cabeçalho do arquivo. */
  sale_price?: string | number | null;
  block: string;
  number: string;
  situation: string;
}

export function precoDeReferencia(unidade: UnidadeFacilitaBruta): PrecoDeReferencia | null {
  if (unidade.cost === null || unidade.cost === undefined) return null;
  const valor = Number(unidade.cost);
  if (!Number.isFinite(valor)) return null;
  return {
    valorReferencia: valor,
    quadra: unidade.block,
    lote: unidade.number,
  };
}
