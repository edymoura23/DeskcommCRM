/**
 * Publish wrapper around the SQL function fn_publish_ai_agent_version.
 * Spec 10 §4.5.
 *
 * Returns a discriminated result so the caller maps validation errors to 422
 * with a stable error code, and unknown errors to 500.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PUBLISH_ERROR_CODES, type PublishErrorCode } from "./validation";
import { publicacaoAvancaLinhaDoTempo } from "./versionamento";

export interface PublishOk {
  ok: true;
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export interface PublishFail {
  ok: false;
  code: PublishErrorCode | "internal_error";
  message: string;
}

export type PublishResult = PublishOk | PublishFail;

interface PublishRow {
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export async function publishAgentVersion(
  admin: SupabaseClient,
  params: { orgId: string; agentId: string; versionId: string },
): Promise<PublishResult> {
  // Todos os caminhos de publicação passam por este wrapper. A RPC aceita
  // superseded para suportar o revert por CLONE, mas publicar diretamente uma
  // versão anterior recolocaria configuração velha no ar. O clone legítimo já
  // nasce com número maior e passa por esta guarda.
  const { data: agent, error: agentError } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("id", params.agentId)
    .eq("organization_id", params.orgId)
    .maybeSingle();
  if (agentError) {
    return { ok: false, code: "internal_error", message: agentError.message };
  }
  if (!agent) {
    return { ok: false, code: "agent_not_found", message: "agent_not_found" };
  }

  const ids = [params.versionId, agent.published_version_id].filter(
    (id): id is string => typeof id === "string",
  );
  const { data: rows, error: versionsError } = await admin
    .from("ai_agent_versions")
    .select("id, agent_id, version_number")
    .eq("organization_id", params.orgId)
    .eq("agent_id", params.agentId)
    .in("id", ids);
  if (versionsError) {
    return { ok: false, code: "internal_error", message: versionsError.message };
  }
  const versions = (rows ?? []) as Array<{
    id: string;
    agent_id: string;
    version_number: number;
  }>;
  const target = versions.find((version) => version.id === params.versionId);
  if (!target) {
    return { ok: false, code: "version_not_found", message: "version_not_found" };
  }
  const current = agent.published_version_id
    ? versions.find((version) => version.id === agent.published_version_id)
    : null;
  if (agent.published_version_id && !current) {
    return { ok: false, code: "internal_error", message: "published_version_not_found" };
  }
  if (!publicacaoAvancaLinhaDoTempo(target.version_number, current?.version_number ?? null)) {
    return { ok: false, code: "version_not_newer", message: "version_not_newer" };
  }

  const { data, error } = await admin
    .rpc("fn_publish_ai_agent_version", {
      p_org_id: params.orgId,
      p_agent_id: params.agentId,
      p_version_id: params.versionId,
    });

  if (error) {
    // Postgres P0001 with the reason as message.
    const raw = (error.message ?? "").trim();
    if (PUBLISH_ERROR_CODES.has(raw)) {
      return { ok: false, code: raw as PublishErrorCode, message: raw };
    }
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  const row = Array.isArray(data) ? (data[0] as PublishRow | undefined) : (data as PublishRow | null);
  if (!row) {
    return { ok: false, code: "internal_error", message: "no_row_returned" };
  }
  return {
    ok: true,
    agent_id: row.agent_id,
    version_id: row.version_id,
    previous_version_id: row.previous_version_id,
    published_at: row.published_at,
  };
}
