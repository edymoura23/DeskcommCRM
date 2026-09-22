import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { createSupabaseAdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";

function ponteSupabase(admin: SupabaseClient): TurnBridgeAdminClient {
  const base = createSupabaseAdminClient(admin);
  return {
    ...base,
    async loadEnrollmentById(orgId, id) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return data as EnrollmentRow;
    },
  };
}

/** Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker. */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);

  let enviados = 0;
  const ponte = ponteSupabase(admin);
  for (const job of jobs ?? []) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    const body = payload.fixed_body;
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    if (typeof body !== "string" || !body || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    const { data: claimed, error: claimErr } = await admin
      .from("job_queue")
      .update({ status: "running" })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) continue;

    try {
      const { data: enr } = await admin
        .from("followup_enrollments")
        .select("current_node_id")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .maybeSingle();
      if (!enr || enr.current_node_id !== nodeId) {
        await admin.from("job_queue").update({ status: "done" }).eq("id", job.id);
        continue;
      }

      // O redrive pode ter submetido a linha enquanto este job aguardava em
      // pending. Reconciliar pela identidade do job evita criar uma segunda
      // mensagem no tick seguinte.
      const { data: anterior, error: anteriorErr } = await admin
        .from("messages")
        .select("id, status")
        .eq("organization_id", job.organization_id as string)
        .contains("metadata", { followup_job_id: job.id })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (anteriorErr) throw new Error(anteriorErr.message);
      if (anterior && ["sent", "delivered", "read"].includes(anterior.status)) {
        await completeTurnForEnrollment(ponte, job.organization_id as string, enrollmentId, nodeId, {
          kind: "sent",
        });
        await admin.from("job_queue").update({ status: "done" }).eq("id", job.id);
        enviados++;
        continue;
      }
      if (anterior && ["queued", "sending"].includes(anterior.status)) {
        await admin.from("job_queue").update({ status: "pending" }).eq("id", job.id);
        continue;
      }
      const sessionId = await sessaoProntaParaEnvio(admin, job.organization_id as string);
      if (!sessionId) {
        logger.warn("[dev.pipeline] sem sessão de canal — job volta pra pending");
        await admin.from("job_queue").update({ status: "pending" }).eq("id", job.id);
        continue;
      }
      const conversationId = await ensureConversation(
        admin,
        job.organization_id as string,
        contactId,
        sessionId,
      );
      const mensagem = await sendMessageHandler(
        admin,
        {
          organization_id: job.organization_id as string,
          actor: { type: "webhook_source", id: enrollmentId },
          requestId: `followup:${job.id}`,
        },
        {
          conversation_id: conversationId,
          type: "text",
          body,
          metadata: { followup_job_id: job.id },
        },
      );
      if (mensagem.status === "queued") {
        logger.warn("[dev.pipeline] mensagem aguardando submissão — job volta para pending");
        await admin.from("job_queue").update({ status: "pending" }).eq("id", job.id);
        continue;
      }
      if (mensagem.status === "failed") {
        throw new Error(`mensagem_failed: ${mensagem.error_code ?? "provider_error"}`);
      }
      enviados++;
      try {
        await completeTurnForEnrollment(ponte, job.organization_id as string, enrollmentId, nodeId, {
          kind: "sent",
        });
      } catch (err) {
        logger.warn("[dev.pipeline] completeTurn apos envio", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const { error: doneErr } = await admin.from("job_queue").update({ status: "done" }).eq("id", job.id);
      if (doneErr) throw new Error(doneErr.message);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      await admin
        .from("job_queue")
        .update({ status: "pending", last_error: message.slice(0, 300) })
        .eq("id", job.id);
    }
  }
  return enviados;
}
