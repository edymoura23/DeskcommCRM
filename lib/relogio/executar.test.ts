/**
 * `executarTickDoRelogio()` grava o heartbeat do follow-up.
 *
 * Motivo: `checkFollowupClock` (app/api/v1/health/route.ts) só enxerga o
 * relógio vivo se ALGUÉM escrever em `cron_heartbeats`. Antes desta mudança
 * só o cron dedicado (app/api/v1/cron/followup-flow-worker/route.ts) gravava
 * — e no Vercel Hobby (caso real do JBA, sem o container `scheduler`) quem
 * bate o relógio é `/api/v1/system/relogio/tick`, isto é, esta função, que
 * nunca escrevia. Resultado medido: `/api/v1/health` reportava
 * `followup_clock: down` permanentemente numa instalação saudável — o falso
 * alarme que este teste impede de voltar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({
  recoverStuckMessages: vi.fn(async () => ({ failed: 0 })),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  idsDoContatoEGemeos: vi.fn(async () => []),
}));
vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ done: 0, failed: 0, dead: 0 })),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({
  ensureHandlersRegistered: vi.fn(),
}));
vi.mock("@/lib/followup/agent-followup-gate", () => ({
  createSupabaseFollowupGateDb: vi.fn(() => ({})),
}));
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  inboundEhDestaPergunta: vi.fn(() => false),
}));
vi.mock("@/lib/followup/engine", () => ({
  aplicarRespostaInbound: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({})),
  runFollowupTick: vi.fn(async () => ({ claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 })),
}));
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: vi.fn(async () => 0),
}));
vi.mock("@/lib/followup/silence-sweep", () => ({
  createSupabaseSilenceSweepDb: vi.fn(() => ({})),
  runSilenceSweep: vi.fn(async () => ({ enrolled: 0, pointers_gated_out: 0, skipped_existing: 0 })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/routing/worker", () => ({
  runRoutingWorker: vi.fn(async () => ({})),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

function criarAdminMock() {
  const heartbeatUpsert = vi.fn(() => Promise.resolve({ error: null }));
  const from = vi.fn((table: string) => {
    if (table === "cron_heartbeats") {
      return { upsert: heartbeatUpsert };
    }
    if (table === "followup_enrollments") {
      return {
        select: () => ({
          in: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      };
    }
    throw new Error(`admin.from("${table}") inesperado neste teste`);
  });
  return { from, heartbeatUpsert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executarTickDoRelogio — heartbeat do follow-up", () => {
  it("grava cron_heartbeats.job_name='followup-flow-worker' a cada tick, mesmo sem cron dedicado", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const adminMock = criarAdminMock();
    vi.mocked(createAdminClient).mockReturnValue(adminMock as never);

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    await executarTickDoRelogio();

    expect(adminMock.from).toHaveBeenCalledWith("cron_heartbeats");
    expect(adminMock.heartbeatUpsert).toHaveBeenCalledTimes(1);
    const [payload, opts] = adminMock.heartbeatUpsert.mock.calls[0] as [
      { job_name: string; last_run_at: string },
      { onConflict: string },
    ];
    expect(payload.job_name).toBe("followup-flow-worker");
    expect(new Date(payload.last_run_at).toString()).not.toBe("Invalid Date");
    expect(opts).toEqual({ onConflict: "job_name" });
  });

  it("falha ao gravar o heartbeat não derruba o tick (fire-and-forget)", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const adminMock = criarAdminMock();
    adminMock.heartbeatUpsert.mockReturnValue(Promise.resolve({ error: { message: "db down" } }));
    vi.mocked(createAdminClient).mockReturnValue(adminMock as never);

    const { executarTickDoRelogio } = await import("@/lib/relogio/executar");
    const resultado = await executarTickDoRelogio();

    const tarefaDoFollowup = resultado.tarefas.find((t) => t.id === "followup-flow-worker");
    expect(tarefaDoFollowup?.ok).toBe(true);
  });
});
