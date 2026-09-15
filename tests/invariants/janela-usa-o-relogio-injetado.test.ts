import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A JANELA DE HORÁRIO É DECIDIDA PELO RELÓGIO INJETADO — nunca pelo de parede —
 * E SÓ ADIA O QUE É PROATIVO. Resposta ao cliente é 24/7.
 *
 * ─── MUDANÇA DELIBERADA DE PRODUTO (2026-09-08) ────────────────────────────
 *
 * "Mudança deliberada de produto: mensagens REATIVAS originadas por interação
 *  do cliente devem ser atendidas 24/7. A janela 07h–22h/domingo é regra de
 *  cortesia/antiabuso para comunicação PROATIVA, não para resposta ao cliente."
 *
 * Este arquivo é `tests/invariants/**` (CONGELADO — `loop/hooks/freeze-invariants.sh`).
 * A edição foi autorizada pela governança: `DESKCOMM_GOV_INVARIANTS_EDIT=1` no
 * commit + a justificativa acima citada na mensagem. NÃO é enfraquecimento — a
 * proteção continua inteira, agora expressando a regra certa: o PROATIVO
 * (`followup_turn` com envio) segue sendo ADIADO fora da janela; o REATIVO
 * (`inbound_turn`, `case_reply_turn`) NUNCA é adiado.
 *
 * ─── O defeito ORIGINAL que este arquivo impede (segue valendo p/ o proativo) ─
 *
 * `InboundTurnDeps.clock` (ou `FollowupTurnDeps.clock`) decide a janela. O gate
 * lia `new Date()` direto: um CHECK OBRIGATÓRIO (`invariants`) que dependia da
 * hora do PR — reprovava 22h–7h, passava no resto (medido 2026-08-24). Os casos
 * "FORA→…" abaixo injetam um instante FORA e reprovam DE DIA se o relógio de
 * parede voltar.
 *
 * ─── O bug ESTRUTURAL que a mudança conserta (medido no E2E do JBA, 2026-09-08) ─
 *
 * A guarda de janela em `executarTurnoDoAgente` usava `turnoVaiFalarComOLead`
 * (que inclui `inbound_turn`) e adiava o turno REATIVO inteiro. Um cliente que
 * escrevia 01h30 BRT só recebia resposta às 07h — sem LLM, sem RAG, sem nada.
 * Antes disso já existia o "turno ok sem mensagem" (2026-08-18): o veto de
 * janela virava erro-de-ensino no `send_message` e o turno terminava `ok` com
 * ZERO outbound. A guarda passou a usar `turnoAdiaPorJanela` (só o proativo), e
 * o gate `pacing` ganhou `reactiveInbound` (pula SÓ janela+domingo; warm-up /
 * cap diário / throttle seguem). O caso "inbound_turn FORA → CORRE e envia
 * EXATAMENTE 1" abaixo é a regressão dos DOIS defeitos: nem adiamento indevido,
 * nem "turno ok sem mensagem".
 *
 * ─── Cobertura ────────────────────────────────────────────────────────────────
 *
 *   inbound_turn    FORA da janela → CORRE, exatamente 1 outbound
 *   case_reply_turn FORA da janela → CORRE / responde (também reativo)
 *   followup_turn   FORA da janela → CONTINUA ADIADO (JobSettledError, 0 outbound)
 *   inbound_turn    DENTRO         → CORRE (comportamento dentro da janela intacto)
 *   followup_turn   DENTRO         → CORRE (proativo dentro da janela funciona)
 *
 * Harness: handlers REAIS (`createInboundTurnHandler` / `createFollowupTurnHandler`
 * / `createCaseReplyTurnHandler`), modelo fake, canal que CAPTURA em vez de
 * enviar, `sleep` no-op, relógio injetado. Ids próprios (o `setupFile` recria o
 * banco por arquivo).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "dddddddd-0000-4000-8000-0000000000a1";
const CONTACT = "dddddddd-0000-4000-8000-0000000000a2";
const SESSION = "dddddddd-0000-4000-8000-0000000000a3";
const CONV = "dddddddd-0000-4000-8000-0000000000a4";
const MSG = "dddddddd-0000-4000-8000-0000000000a5";
const CRM_EVENT = "dddddddd-0000-4000-8000-0000000000a6";
const CASO = "dddddddd-0000-4000-8000-0000000000a7";

/** Terça, 15h BRT — dentro da janela anti-ban padrão (7h–22h). */
const DENTRO_DA_JANELA = new Date("2026-07-28T18:00:00Z");
/** Terça, 3h BRT — fora dela, com folga dos dois lados. */
const FORA_DA_JANELA = new Date("2026-07-28T06:00:00Z");

interface EnvioCapturado {
  body: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  createFollowupTurnHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;
  createCaseReplyTurnHandler: typeof import("@/lib/agent-engine/agent/case-reply-turn").createCaseReplyTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

type TurnKind = "inbound_turn" | "followup_turn" | "case_reply_turn";

let enviados: EnvioCapturado[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Modelo fake que manda UMA mensagem e encerra. `rotulo` é único por caso: os
 * dois compartilham a mesma conversa, e o gate `spinning` veta corpo repetido
 * entre turnos — sem o rótulo, o segundo caso seria bloqueado por um motivo
 * que não é o deste arquivo.
 */
function modeloQueManda(rotulo: string) {
  let mandou = false;
  return async () => {
    if (!mandou) {
      mandou = true;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: `oi, tudo bem? (${rotulo})` }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/** Deps compartilhadas pelos 3 handlers (FollowupTurnDeps ⊇ InboundTurnDeps). */
function montaDeps(doGenerate: unknown, instante: Date) {
  return {
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // O ponto do arquivo: é ESTE instante que decide a janela, e não a hora em
    // que a suíte por acaso rodou.
    clock: () => instante,
    sleep: async () => {},
  };
}

function montaHandler(kind: TurnKind, doGenerate: unknown, instante: Date) {
  const deps = montaDeps(doGenerate, instante) as never;
  if (kind === "followup_turn") return m.createFollowupTurnHandler(deps);
  if (kind === "case_reply_turn") return m.createCaseReplyTurnHandler(deps);
  return m.createInboundTurnHandler(deps);
}

async function rodaTurno(
  kind: TurnKind,
  handler: ReturnType<typeof montaHandler>,
): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const payload =
    kind === "case_reply_turn"
      ? { case_id: CASO, action: "need_lead_info", body: "qual o CEP do lote?" }
      : kind === "followup_turn"
        ? { channel_session_id: SESSION }
        : {
            conversation_id: CONV,
            contact_id: CONTACT,
            channel_session_id: SESSION,
            inbound_message_id: MSG,
            crm_event_id: CRM_EVENT,
          };
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind,
    leadId: CONTACT,
    payload,
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "janela", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "janela" });
    await m.queue.completeJob(pool, claimed!.id, "janela");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "janela", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    createFollowupTurnHandler: (await import("@/lib/agent-engine/agent/followup-turn"))
      .createFollowupTurnHandler,
    createCaseReplyTurnHandler: (await import("@/lib/agent-engine/agent/case-reply-turn"))
      .createCaseReplyTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'janela-relogio','Janela Relogio','Janela Relogio') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead da Janela','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'janela-relogio-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
  // Caso aberto p/ o `case_reply_turn` — status pós-transição da rota humana
  // (`need_lead_info` → `awaiting_lead`, ver EXPECTED_STATUS_FOR_ACTION). agent_id
  // fica NULL (FK ON DELETE SET NULL); title/summary/blocker são NOT NULL sem default.
  await pool.query(
    `insert into agent_cases (id, organization_id, conversation_id, agent_id, status, title, summary, blocker, source)
     values ($1,$2,$3,null,'awaiting_lead','Caso da janela','—','—','agent')
     on conflict (id) do nothing`,
    [CASO, ORG, CONV],
  );
});

beforeEach(() => {
  enviados = [];
});

describe("a janela de horário é decidida pelo relógio injetado — e só adia o PROATIVO", () => {
  it("inbound_turn FORA da janela: CORRE e envia EXATAMENTE 1 (nem adia, nem 'turno ok sem mensagem')", async () => {
    const erro = await rodaTurno(
      "inbound_turn",
      montaHandler("inbound_turn", modeloQueManda("reativo-noturno"), FORA_DA_JANELA),
    );

    // Resposta REATIVA ao cliente é 24/7. NÃO pode adiar (sem JobSettledError de
    // janela) E NÃO pode terminar `ok` com zero outbound (o bug de 2026-08-18).
    expect(erro).toBeNull();
    expect(String(erro?.message ?? "")).not.toMatch(/fora da janela anti-ban/);
    expect(enviados).toHaveLength(1);
  });

  it("case_reply_turn FORA da janela: CORRE / responde (também é reativo — humano agiu num caso)", async () => {
    const erro = await rodaTurno(
      "case_reply_turn",
      montaHandler("case_reply_turn", modeloQueManda("reativo-caso-noturno"), FORA_DA_JANELA),
    );

    expect(erro).toBeNull();
    expect(String(erro?.message ?? "")).not.toMatch(/fora da janela anti-ban/);
    expect(enviados).toHaveLength(1);
  });

  it("followup_turn FORA da janela: CONTINUA ADIADO (proativo respeita a cortesia)", async () => {
    const erro = await rodaTurno(
      "followup_turn",
      montaHandler("followup_turn", modeloQueManda("proativo-noturno"), FORA_DA_JANELA),
    );

    // Adiado, não gasto: `JobSettledError` é o contrato de "o run já dispôs do
    // job". Reengajamento proativo às 3h acordaria o cliente — vai para as 7h.
    expect(erro).not.toBeNull();
    expect(String(erro?.message)).toMatch(/fora da janela anti-ban/);
    expect(enviados).toHaveLength(0);
  });

  it("inbound_turn DENTRO da janela: CORRE — o comportamento dentro da janela segue intacto", async () => {
    const erro = await rodaTurno(
      "inbound_turn",
      montaHandler("inbound_turn", modeloQueManda("reativo-diurno"), DENTRO_DA_JANELA),
    );

    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
  });

  it("followup_turn DENTRO da janela: CORRE — o proativo dentro da janela funciona", async () => {
    const erro = await rodaTurno(
      "followup_turn",
      montaHandler("followup_turn", modeloQueManda("proativo-diurno"), DENTRO_DA_JANELA),
    );

    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
  });
});
