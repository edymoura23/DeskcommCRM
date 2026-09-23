/**
 * Regras puras da linha do tempo de versões de um agente.
 *
 * A versão publicada divide rascunho vigente de histórico: somente uma versão
 * numericamente posterior pode continuar recebendo edições ou substituir a
 * que está no ar. O histórico antigo permanece no banco, mas nunca volta a ser
 * veículo de save/publish.
 */

export interface VersaoNumerada {
  id: string;
  version_number: number;
}

export function draftVigente<T extends VersaoNumerada>(
  drafts: readonly T[],
  publishedVersionNumber: number | null,
): T | null {
  return drafts.reduce<T | null>((maisNova, draft) => {
    if (publishedVersionNumber !== null && draft.version_number <= publishedVersionNumber) {
      return maisNova;
    }
    if (maisNova === null || draft.version_number > maisNova.version_number) return draft;
    return maisNova;
  }, null);
}

export function proximoNumeroDeVersao(
  versions: readonly VersaoNumerada[],
  publishedVersionNumber: number | null,
): number {
  const maior = versions.reduce(
    (max, version) => Math.max(max, version.version_number),
    publishedVersionNumber ?? 0,
  );
  return maior + 1;
}

export function publicacaoAvancaLinhaDoTempo(
  targetVersionNumber: number,
  publishedVersionNumber: number | null,
): boolean {
  return publishedVersionNumber === null || targetVersionNumber > publishedVersionNumber;
}
