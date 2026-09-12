/**
 * Cliente HTTP do Facilita — só os 4 GETs necessários para condição/preço/
 * disponibilidade (products/show, availability, salestable + paginação
 * real). Host FIXO, nunca de input do modelo/lead — mesma classe de
 * confiança dos demais clientes de provider externo do repo
 * em `lib/channels/adapters/`, que também chamam `fetch()` direto
 * sem passar pela allowlist de egress do runtime edge (essa allowlist é
 * escopada a chamadas que partem do runtime do agente/LLM, não a um cliente
 * de host fixo chamado de dentro do handler de uma tool).
 *
 * Cache curto (TTL) em memória de processo por credencial+endpoint+parâmetro
 * — o Facilita já cacheia GET por 60s e documenta rate limit de 50-150
 * req/min; não bater a API a cada pergunta do lead numa mesma janela curta.
 */
import type { TabelaFacilitaBruta } from "./vigencia";
import type { UnidadeFacilitaBruta } from "./preco-de-referencia";
import type { FacilitaCredenciais } from "./credenciais";
import type { TabelaComFluxoBruta } from "./fluxo-de-pagamento";

const BASE_URL = "https://api.facilitaapp.com/platform/v1";
const CACHE_TTL_MS = 90_000;

interface EntradaDeCache<T> {
  expiraEm: number;
  valor: T;
}

const cache = new Map<string, EntradaDeCache<unknown>>();

async function comCache<T>(chave: string, buscar: () => Promise<T>): Promise<T> {
  const agora = Date.now();
  const existente = cache.get(chave);
  if (existente && existente.expiraEm > agora) return existente.valor as T;
  const valor = await buscar();
  cache.set(chave, { expiraEm: agora + CACHE_TTL_MS, valor });
  return valor;
}

function cabecalhos(creds: FacilitaCredenciais): HeadersInit {
  return {
    "api-instance": creds.apiInstance,
    "api-key": creds.apiKey,
    "token-user": creds.tokenUser,
  };
}

interface RespostaProductsShow {
  availability_id?: string | number;
}

async function resolverAvailabilityId(creds: FacilitaCredenciais): Promise<string> {
  if (creds.availabilityId) return creds.availabilityId;
  return comCache(`products_show:${creds.productId}`, async () => {
    const res = await fetch(
      `${BASE_URL}/products/show?product_id=${encodeURIComponent(creds.productId)}`,
      { headers: cabecalhos(creds) },
    );
    if (!res.ok) throw new Error(`facilita_products_show_falhou: ${res.status}`);
    const json = (await res.json()) as RespostaProductsShow;
    if (json.availability_id === undefined || json.availability_id === null) {
      throw new Error("facilita_sem_availability_id");
    }
    return String(json.availability_id);
  });
}

interface RespostaSalestable {
  data?: TabelaFacilitaBruta[];
}

export async function buscarCondicoesVigentesBruto(
  creds: FacilitaCredenciais,
): Promise<TabelaFacilitaBruta[]> {
  return comCache(`salestable:${creds.productId}`, async () => {
    const availabilityId = await resolverAvailabilityId(creds);
    const res = await fetch(
      `${BASE_URL}/salestable?availability_id=${encodeURIComponent(availabilityId)}`,
      { headers: cabecalhos(creds) },
    );
    if (!res.ok) throw new Error(`facilita_salestable_falhou: ${res.status}`);
    const json = (await res.json()) as RespostaSalestable | TabelaFacilitaBruta[];
    return Array.isArray(json) ? json : (json.data ?? []);
  });
}

interface RespostaAvailability {
  units: UnidadeFacilitaBruta[];
  last_page: number;
  current_page: number | string;
}

export async function buscarUnidadesDaQuadraBruto(
  creds: FacilitaCredenciais,
  quadra: string,
): Promise<UnidadeFacilitaBruta[]> {
  return comCache(`availability:${creds.productId}:${quadra}`, async () => {
    const availabilityId = await resolverAvailabilityId(creds);
    const encontradas: UnidadeFacilitaBruta[] = [];
    let page = 1;
    for (;;) {
      const res = await fetch(
        `${BASE_URL}/availability?availability_id=${encodeURIComponent(availabilityId)}&per_page=100&page=${page}`,
        { headers: cabecalhos(creds) },
      );
      if (!res.ok) throw new Error(`facilita_availability_falhou: ${res.status}`);
      const json = (await res.json()) as RespostaAvailability;
      for (const unidade of json.units) {
        if (unidade.block === quadra) encontradas.push(unidade);
      }
      const atual = Number(json.current_page);
      if (!json.last_page || Number.isNaN(atual) || atual >= json.last_page) break;
      page += 1;
    }
    return encontradas;
  });
}

export async function buscarFluxoBruto(
  creds: FacilitaCredenciais,
  salesTableId: string | number,
): Promise<TabelaComFluxoBruta> {
  return comCache(`salestable_flow:${creds.productId}:${salesTableId}`, async () => {
    const res = await fetch(
      `${BASE_URL}/salestable/flow?sales_table_id=${encodeURIComponent(String(salesTableId))}`,
      { headers: cabecalhos(creds) },
    );
    if (!res.ok) throw new Error(`facilita_salestable_flow_falhou: ${res.status}`);
    return (await res.json()) as TabelaComFluxoBruta;
  });
}

export async function buscarUnidadeBruta(
  creds: FacilitaCredenciais,
  quadra: string,
  lote: string,
): Promise<UnidadeFacilitaBruta | null> {
  const unidades = await buscarUnidadesDaQuadraBruto(creds, quadra);
  return unidades.find((u) => u.number === lote) ?? null;
}
