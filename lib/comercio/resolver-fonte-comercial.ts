/**
 * Ponto ÚNICO que a tool MCP chama para obter o provider comercial de uma
 * organização — hoje só sabe montar um provider Facilita, mas a assinatura
 * já é `(admin, organizationId) -> ComercioProvider | null`, não
 * `(admin, organizationId, "facilita")`. Um segundo provider futuro entra
 * trocando o `if` interno desta função, sem tocar em tool nem em prompt de
 * agente nenhum (D5 — transversalidade).
 *
 * `null` = "esta organização não tem fonte de dados comercial configurada" —
 * é um estado ESPERADO (a maioria das organizações não terá, no início), não
 * um erro. O chamador (tool) trata como "sem dado", nunca inventa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ComercioProvider,
  CondicaoComercial,
  ContagemDisponibilidade,
  DisponibilidadeUnidade,
  PrecoDeReferencia,
} from "./tipos";
import {
  credenciaisFacilitaDaOrg,
  type FacilitaCredenciais,
} from "./providers/facilita/credenciais";
import {
  buscarCondicoesVigentesBruto,
  buscarFluxoBruto,
  buscarUnidadeBruta,
  buscarUnidadesDaQuadraBruto,
} from "./providers/facilita/client";
import { filtrarTabelasVigentes, type TabelaFacilitaBruta } from "./providers/facilita/vigencia";
import { precoDeReferencia } from "./providers/facilita/preco-de-referencia";
import { situacaoSegura } from "./providers/facilita/situacao-segura";
import { extrairEntradaEParcelas } from "./providers/facilita/fluxo-de-pagamento";
import type { FacilitaCredenciais } from "./providers/facilita/credenciais";

async function paraCondicaoComercial(
  creds: FacilitaCredenciais,
  tabelaVigente: TabelaFacilitaBruta,
): Promise<CondicaoComercial> {
  const desconto =
    tabelaVigente.discount !== undefined && tabelaVigente.discount !== null
      ? Number(tabelaVigente.discount)
      : null;

  // Falha ao buscar o detalhe do fluxo NÃO derruba a condição inteira — a
  // tabela (nome/vigência/desconto) já é útil sozinha; entrada/parcelas só
  // ficam ausentes, nunca inventadas.
  let entrada: CondicaoComercial["entrada"] = null;
  let parcelas: CondicaoComercial["parcelas"] = null;
  try {
    const bruta = await buscarFluxoBruto(creds, tabelaVigente.id);
    const detalhe = extrairEntradaEParcelas(bruta);
    entrada = detalhe.entrada;
    parcelas = detalhe.parcelas;
  } catch {
    // silencioso de propósito: ver comentário acima.
  }

  return {
    id: String(tabelaVigente.id),
    nome: tabelaVigente.name,
    vigenteAte: tabelaVigente.end_date ?? "",
    entrada,
    parcelas,
    desconto: desconto !== null && Number.isFinite(desconto) ? desconto : null,
  };
}

class FacilitaComercioProvider implements ComercioProvider {
  constructor(private readonly creds: FacilitaCredenciais) {}

  async condicoesVigentes(): Promise<CondicaoComercial[]> {
    const brutas = await buscarCondicoesVigentesBruto(this.creds);
    const vigentes = filtrarTabelasVigentes(brutas, new Date());
    return Promise.all(vigentes.map((tabela) => paraCondicaoComercial(this.creds, tabela)));
  }

  async unidade(quadra: string, lote: string): Promise<(PrecoDeReferencia & DisponibilidadeUnidade) | null> {
    const bruta = await buscarUnidadeBruta(this.creds, quadra, lote);
    if (!bruta) return null;
    const preco = precoDeReferencia(bruta);
    if (!preco) return null;
    return {
      ...preco,
      situacao: situacaoSegura(bruta.situation),
    };
  }

  async disponibilidadePorQuadra(quadra: string): Promise<ContagemDisponibilidade> {
    const unidades = await buscarUnidadesDaQuadraBruto(this.creds, quadra);
    const disponiveis = unidades.filter((u) => situacaoSegura(u.situation) === "disponivel").length;
    return { disponiveis, total: unidades.length };
  }
}

export async function resolverFonteComercial(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ComercioProvider | null> {
  const credenciaisFacilita = await credenciaisFacilitaDaOrg(admin, organizationId);
  if (credenciaisFacilita) return new FacilitaComercioProvider(credenciaisFacilita);
  return null;
}
