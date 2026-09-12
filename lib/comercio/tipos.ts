/**
 * Contrato TRANSVERSAL do provider comercial (preço, condições, disponibilidade).
 *
 * Nenhum nome de provider aparece aqui — `lib/comercio/providers/<algo>/`
 * implementa este contrato, e `resolver-fonte-comercial.ts` é o único ponto
 * que sabe QUAL provider concreto está por trás de uma organização. Tools MCP
 * e agente conhecem só este arquivo (mesmo princípio de `docs/doctrine/
 * restricao-de-canal.md` invariante 1, aplicado a provider de DADOS
 * comerciais em vez de canal de mensagem).
 *
 * `CondicaoComercial` e `PrecoDeReferencia` NÃO têm campo de preço realizado
 * de negócio já fechado (o que no Facilita é `sale_price`) — de propósito:
 * esse valor é de outro negócio, de outro cliente, e nunca é preço a citar a
 * um lead novo. A ausência do campo no TIPO torna o vazamento um erro de
 * compilação, não só disciplina de quem escreve o provider.
 */

export interface CondicaoComercial {
  id: string;
  nome: string;
  vigenteAte: string;
  entrada?: { percentual: number } | null;
  parcelas?: { quantidade: number; taxaMensal?: number | null } | null;
  desconto?: number | null;
}

export interface PrecoDeReferencia {
  valorReferencia: number;
  quadra: string;
  lote: string;
}

/** Tradução SEGURA do estado bruto do provider — nunca expõe o código interno nem quem reservou/comprou. */
export type SituacaoSegura = "disponivel" | "indisponivel_no_momento";

export interface DisponibilidadeUnidade {
  quadra: string;
  lote: string;
  situacao: SituacaoSegura;
}

export interface ContagemDisponibilidade {
  disponiveis: number;
  total: number;
}

export interface ComercioProvider {
  condicoesVigentes(): Promise<CondicaoComercial[]>;
  unidade(quadra: string, lote: string): Promise<(PrecoDeReferencia & DisponibilidadeUnidade) | null>;
  disponibilidadePorQuadra(quadra: string): Promise<ContagemDisponibilidade>;
}
