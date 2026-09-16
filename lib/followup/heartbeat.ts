/**
 * Batimento cru do relógio do follow-up — `cron_heartbeats.job_name = "followup-flow-worker"`.
 *
 * Fonte única para os DOIS motores que podem bater este job: o cron dedicado
 * (`app/api/v1/cron/followup-flow-worker/route.ts`, self-host) e o tick do
 * relógio HTTP (`lib/relogio/executar.ts`, motor real no Vercel Hobby — ver
 * migration 0205). Escrever a mesma lógica duas vezes é como o bug que esta
 * função existe para prevenir aconteceu: um motor gravava, o outro não, e
 * `/api/v1/health` (checkFollowupClock) achava o relógio parado numa
 * instalação saudável. Fire-and-forget: falha aqui nunca aborta o tick.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export const JOB_NAME_FOLLOWUP_FLOW_WORKER = "followup-flow-worker";

export function registrarBatidaDoFollowup(
  admin: SupabaseClient,
  origem: string,
  logMetadata?: Record<string, unknown>,
): void {
  void admin
    .from("cron_heartbeats")
    .upsert(
      { job_name: JOB_NAME_FOLLOWUP_FLOW_WORKER, last_run_at: new Date().toISOString() },
      { onConflict: "job_name" },
    )
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) logger.error(`[${origem}] heartbeat write failed`, { error: error.message, ...logMetadata });
    });
}
