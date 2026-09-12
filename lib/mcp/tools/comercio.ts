/**
 * Capacidades de COMÉRCIO — o que o cliente já comprou e o que existe à venda.
 *
 * Ficou de fora do épico até ser cobrado, e era a lacuna mais direta do pilar 1:
 * um agente de vendas que não enxerga o catálogo nem o histórico de pedidos
 * negocia no escuro — promete o que não existe, ou repete uma oferta que o
 * cliente já comprou.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente, e a
 * fonte é sempre `ctx.organizationId` (token/cookie), NUNCA o input.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { resolverFonteComercial } from "@/lib/comercio/resolver-fonte-comercial";

// ---------------------------------------------------------------------------
// pedidos de um cliente
// ---------------------------------------------------------------------------

const pedidosInputShape = {
  contact_id: z.string().uuid().describe("O cliente cujos pedidos se quer ver."),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const crmListContactOrders: McpToolDefinition<typeof pedidosInputShape> = {
  name: "crm_list_contact_orders",
  description:
    "Lista os pedidos de um contato, do mais recente para o mais antigo, com status, valor, " +
    "forma de pagamento, situação de entrega e código de rastreio. Use antes de prometer prazo " +
    "ou repetir oferta: o cliente pode já ter comprado.",
  inputSchema: pedidosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, ordered_at, is_anonymized",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", input.contact_id)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(input.limite);

    if (error) throw new Error(`listar_pedidos_falhou: ${error.message}`);

    return {
      pedidos: (data ?? []).map((p) => ({
        ...p,
        // Pedido anonimizado por LGPD continua contando para histórico, mas o
        // conteúdo não volta: dizer isso é melhor que devolver campos vazios e
        // deixar o modelo concluir que o cliente nunca comprou.
        ...(p.is_anonymized ? { aviso: "pedido anonimizado a pedido do titular" } : {}),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// buscar no catálogo
// ---------------------------------------------------------------------------

const produtosInputShape = {
  termo: z.string().trim().min(2).describe("Parte do nome do produto."),
  limite: z.number().int().min(1).max(20).optional().default(10),
  somente_disponiveis: z.boolean().optional().default(true),
};

export const crmSearchProducts: McpToolDefinition<typeof produtosInputShape> = {
  name: "crm_search_products",
  description:
    "Busca produtos do catálogo da loja por parte do nome. Devolve preço, quantidade disponível " +
    "e link. Use para responder preço e disponibilidade com o dado da loja em vez de estimar.",
  inputSchema: produtosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("nuvemshop_products")
      .select("id, external_id, title, description, price_cents, available_qty, url, image_url")
      .eq("organization_id", ctx.organizationId)
      .ilike("title", `%${input.termo}%`)
      .limit(input.limite);

    // Oferecer o que está sem estoque é pior que não achar: o cliente ouve um
    // sim e recebe um não depois.
    if (input.somente_disponiveis) q = q.gt("available_qty", 0);

    const { data, error } = await q;
    if (error) throw new Error(`buscar_produtos_falhou: ${error.message}`);

    return {
      produtos: data ?? [],
      ...(data && data.length === 0
        ? { aviso: input.somente_disponiveis ? "nada com esse nome em estoque" : "nada com esse nome no catálogo" }
        : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// condições comerciais e disponibilidade (preço/condição/lote) — transversal:
// nenhuma menção a JBA/AURORA/WhatsApp/Facilita aqui. `resolverFonteComercial`
// é quem sabe qual provider concreto atende esta organização.
// ---------------------------------------------------------------------------

const condicoesInputShape = {
  quadra: z.string().trim().min(1).optional().describe("Quadra do lote, se o cliente já tiver informado."),
  lote: z.string().trim().min(1).optional().describe("Número do lote, se o cliente já tiver informado."),
};

export const crmConsultarCondicoesComerciais: McpToolDefinition<typeof condicoesInputShape> = {
  name: "crm_consultar_condicoes_comerciais",
  description:
    "Consulta as condições comerciais vigentes agora (tabelas de pagamento, desconto) e, se quadra e lote " +
    "forem informados, o preço de referência do lote. Use antes de responder preço ou condição — nunca " +
    "estime, nunca repita um valor de memória ou de conversa anterior.",
  inputSchema: condicoesInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const provider = await resolverFonteComercial(ctx.supabase, ctx.organizationId);
    if (!provider) {
      return { aviso: "esta organização não tem fonte de dados comercial configurada" };
    }

    const condicoes = await provider.condicoesVigentes();
    if (!input.quadra || !input.lote) {
      return { condicoes };
    }

    const unidade = await provider.unidade(input.quadra, input.lote);
    if (!unidade) {
      return { condicoes, aviso: "lote não encontrado ou fora de estoque" };
    }
    return { condicoes, unidade };
  },
};

const disponibilidadeInputShape = {
  quadra: z.string().trim().min(1).describe("Quadra a consultar."),
  lote: z.string().trim().min(1).optional().describe("Número do lote, para a situação de uma unidade específica."),
};

export const crmConsultarDisponibilidadeLote: McpToolDefinition<typeof disponibilidadeInputShape> = {
  name: "crm_consultar_disponibilidade_lote",
  description:
    "Consulta a disponibilidade real de lotes numa quadra (contagem), ou a situação de um lote específico " +
    "quando quadra e lote forem informados. Use antes de dizer que um lote está disponível — a situação muda " +
    "por venda ou reserva a qualquer momento.",
  inputSchema: disponibilidadeInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const provider = await resolverFonteComercial(ctx.supabase, ctx.organizationId);
    if (!provider) {
      return { aviso: "esta organização não tem fonte de dados comercial configurada" };
    }

    if (input.lote) {
      const unidade = await provider.unidade(input.quadra, input.lote);
      if (!unidade) {
        return { aviso: "lote não encontrado ou fora de estoque" };
      }
      return { quadra: unidade.quadra, lote: unidade.lote, situacao: unidade.situacao };
    }

    return provider.disponibilidadePorQuadra(input.quadra);
  },
};
