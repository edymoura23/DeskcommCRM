/**
 * Filtro de vigência das tabelas de venda do Facilita.
 *
 * A API `salestable` devolve tabela vigente e expirada JUNTAS — comprovado
 * com dado real (Atlântica Clube: 29 das 33 tabelas cadastradas já haviam
 * expirado em 2022/2023, GET real em 2026-09-10). Nenhum código que cite uma
 * tabela de condição pode pular este filtro — não é seguro depender de o
 * modelo "lembrar" de checar data.
 */

export interface TabelaFacilitaBruta {
  id: number | string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  discount?: number | string | null;
  [chave: string]: unknown;
}

export function filtrarTabelasVigentes(
  tabelas: readonly TabelaFacilitaBruta[],
  hoje: Date,
): TabelaFacilitaBruta[] {
  return tabelas.filter((tabela) => {
    const inicio = tabela.start_date ? new Date(tabela.start_date) : null;
    const fim = tabela.end_date ? new Date(tabela.end_date) : null;
    if (inicio && inicio > hoje) return false;
    if (fim && fim < hoje) return false;
    return true;
  });
}
