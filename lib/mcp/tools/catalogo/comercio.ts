/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_search_products",
    category: "read",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto pelo nome e devolve preço e quantidade em estoque, para o assistente responder com o dado da loja em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
  {
    name: "crm_consultar_condicoes_comerciais",
    category: "read",
    rotulo: "Consultar condições comerciais vigentes",
    explicacao:
      "Busca as condições de pagamento e o preço de referência vigentes agora, para o assistente responder preço e condição com dado real em vez de estimar ou repetir uma tabela antiga.",
    oQueToca: "Condições comerciais e preço",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_consultar_disponibilidade_lote",
    category: "read",
    rotulo: "Consultar disponibilidade de lote",
    explicacao:
      "Verifica se um lote, ou uma quadra inteira, está disponível agora, para o assistente não prometer algo que já foi vendido ou reservado.",
    oQueToca: "Disponibilidade de lotes",
    risco: "seguro",
    pacotes: ["vender"],
  },
]);
