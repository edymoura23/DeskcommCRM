/**
 * Credenciais do Facilita — por organização, cifradas.
 *
 * Mesmo desenho já usado por credenciais de canal externo em `lib/channels/`: busca por
 * `organization_id` (nunca de input do chamador), decifra com a MESMA cifra
 * do resto do repo (`fn_encrypt_oauth`/`fn_decrypt_oauth`, via
 * `lib/webhooks/secrets.ts`), `null` = "esta org não tem fonte comercial
 * configurada" — NUNCA erro/exceção para esse caso (o chamador de tool trata
 * como "sem dado", não como falha).
 *
 * As 3 credenciais do Facilita (api-instance, api-key, token-user) são
 * cifradas JUNTAS, serializadas em JSON, num único campo
 * `credentials_encrypted` — decisão de D3 do gate: menos superfície, 1
 * decrypt por leitura.
 *
 * Erro de CONSULTA (não de ausência) é lançado, nunca engolido — descartar o
 * `error` foi a metade do defeito da issue #236 (mesma lição aplicada a um
 * canal de mensagem): um erro descartado pode virar silenciosamente "não
 * configurada" quando na verdade a consulta falhou por outro motivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface FacilitaCredenciais {
  apiInstance: string;
  apiKey: string;
  tokenUser: string;
  productId: string;
  availabilityId: string | null;
}

interface CredencialCifradaBruta {
  api_instance: string;
  api_key: string;
  token_user: string;
}

function pareceCredencialValida(v: unknown): v is CredencialCifradaBruta {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.api_instance === "string" && typeof r.api_key === "string" && typeof r.token_user === "string";
}

export async function credenciaisFacilitaDaOrg(
  admin: SupabaseClient,
  organizationId: string,
): Promise<FacilitaCredenciais | null> {
  const { data, error } = await admin
    .from("commercial_data_sources")
    .select("product_id, availability_id, credentials_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "facilita")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `commercial_data_sources_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }
  if (!data) return null;

  const cifrado = data.credentials_encrypted as unknown as string | null;
  if (!cifrado) return null;

  const plaintext = await decryptWebhookSecret(admin, cifrado);
  if (!plaintext) return null;

  let bruto: unknown;
  try {
    bruto = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!pareceCredencialValida(bruto)) return null;

  return {
    apiInstance: bruto.api_instance,
    apiKey: bruto.api_key,
    tokenUser: bruto.token_user,
    productId: data.product_id as string,
    availabilityId: (data.availability_id as string | null) ?? null,
  };
}
