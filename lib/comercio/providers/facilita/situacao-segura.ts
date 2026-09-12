/**
 * Tradução SEGURA dos 7 estados nativos de `situation` desta instância do
 * Facilita (comprovado por GET real, 2026-09) para uma categoria que pode
 * ser conversada com um lead — nunca o código bruto, nunca quem
 * reservou/comprou.
 *
 * Fail-closed de propósito: um estado desconhecido (instância nova, valor
 * novo que o Facilita passe a devolver) cai em "indisponível", nunca em
 * "disponível" — prometer disponibilidade errada é o dano maior.
 */
import type { SituacaoSegura } from "../../tipos";

const MAPA_DE_SITUACAO: Record<string, SituacaoSegura> = {
  available: "disponivel",
  "pre-reserve": "disponivel",
  reserved: "indisponivel_no_momento",
  "reserved-permanetly": "indisponivel_no_momento", // grafia real da API (não é typo nosso)
  sale: "indisponivel_no_momento",
  unavailable: "indisponivel_no_momento",
  under_review_rescission: "indisponivel_no_momento",
};

export function situacaoSegura(situationBruta: string): SituacaoSegura {
  return MAPA_DE_SITUACAO[situationBruta] ?? "indisponivel_no_momento";
}
