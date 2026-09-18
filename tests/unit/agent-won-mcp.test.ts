import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { crmCreateLead, crmMoveLeadStage } from "@/lib/mcp/tools/leads";
import { crmCloseDemand } from "@/lib/mcp/tools/retencao";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { createLeadSchema } from "@/lib/schemas/leads";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type * as ActivityEmitter from "@/lib/leads/activity-emitter";
import { ai, human, ids, context, mcpContext, crmFixture } from "./helpers/w2-crm-fixture";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", async (original) => ({
  ...(await original<typeof ActivityEmitter>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true, activityId: "activity-fixture" })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn() }));

function noCommercialEffects(f: ReturnType<typeof crmFixture>, before: string) {
  expect(f.snapshot()).toBe(before);
  expect(f.updates).not.toHaveBeenCalled();
  expect(f.inserts).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(emitLeadActivity).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
}

describe("W2 — domínio e tools MCP reais, sem banco", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["handler", "mcp"] as const)("IA manager não ganha via move %s", async (path) => {
    const f = crmFixture();
    const before = f.snapshot();
    for (let retry = 0; retry < 2; retry++) {
      const call =
        path === "handler"
          ? moveLeadHandler(f.supabase, context(ai), ids.lead, { to_stage_id: ids.won })
          : crmMoveLeadStage.handler(
              { lead_id: ids.lead, to_stage_id: ids.won },
              mcpContext(f.supabase, ai),
            );
      await expect(call).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
    expect(f.selections).toContain("id, pipeline_id, organization_id, name, is_won");
    noCommercialEffects(f, before);
  });

  it("move won da IA continua recusado em no-op de lead já ganho", async () => {
    const f = crmFixture({ initialStatus: "won" });
    const before = f.snapshot();
    await expect(
      moveLeadHandler(f.supabase, context(ai), ids.lead, { to_stage_id: ids.won }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    noCommercialEffects(f, before);
  });

  it.each(["handler", "mcp"] as const)(
    "humano continua podendo ganhar via move %s",
    async (path) => {
      const f = crmFixture();
      const result =
        path === "handler"
          ? await moveLeadHandler(f.supabase, context(human), ids.lead, { to_stage_id: ids.won })
          : await crmMoveLeadStage.handler(
              { lead_id: ids.lead, to_stage_id: ids.won },
              mcpContext(f.supabase, human),
            );
      expect(result).toMatchObject(
        path === "handler" ? { status: "won" } : { lead: { status: "won" } },
      );
      expect(f.lead()).toMatchObject({
        status: "won",
        stage_id: ids.won,
        closed_at: expect.any(String),
      });
      expect(f.updates).toHaveBeenCalledTimes(1);
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(emitLeadActivity).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
    },
  );

  it("IA continua movendo para etapa comum", async () => {
    const f = crmFixture();
    await crmMoveLeadStage.handler(
      { lead_id: ids.lead, to_stage_id: ids.open },
      mcpContext(f.supabase, ai),
    );
    expect(f.lead()).toMatchObject({ status: "open", stage_id: ids.open });
    expect(emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: ai }),
    );
  });

  it("move para perda preserva lost_reason previamente válido", async () => {
    const f = crmFixture({ lostReason: "requested_by_customer" });
    await moveLeadHandler(f.supabase, context(ai), ids.lead, {
      to_stage_id: ids.lost,
      reason: "Desistência explícita",
    });
    expect(f.lead()).toMatchObject({
      status: "lost",
      lost_reason: "requested_by_customer",
      stage_id: ids.lost,
    });
  });

  it("fixture não aceita perda sem lost_reason só porque existe reason de timeline", async () => {
    const f = crmFixture();
    const before = f.snapshot();
    await expect(
      moveLeadHandler(f.supabase, context(ai), ids.lead, {
        to_stage_id: ids.lost,
        reason: "Desistência explícita",
      }),
    ).rejects.toMatchObject({ status: 500, message: "lost_reason_required" });
    expect(f.snapshot()).toBe(before);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    { stageOrg: "other-org", status: 404 },
    { stagePipeline: "other-pipeline", status: 422 },
  ])("move preserva recusa de destino inválido $status", async ({ status, ...options }) => {
    const f = crmFixture(options);
    const before = f.snapshot();
    await expect(
      moveLeadHandler(f.supabase, context(ai), ids.lead, { to_stage_id: ids.won }),
    ).rejects.toMatchObject({ status });
    noCommercialEffects(f, before);
  });

  it.each(["open", "won"] as const)(
    "IA não fecha demanda %s, inclusive retry/no-op",
    async (initialStatus) => {
      const f = crmFixture({ initialStatus });
      const before = f.snapshot();
      for (let retry = 0; retry < 2; retry++) {
        await expect(
          encerraDemanda(f.supabase, context(ai), { leadId: ids.lead, desfecho: "won" }),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
        expect(
          await crmCloseDemand.handler(
            { lead_id: ids.lead, outcome: "won" },
            mcpContext(f.supabase, ai),
          ),
        ).toMatchObject({
          encerrado: false,
          motivo: "forbidden",
          mensagem: expect.stringContaining("humana"),
        });
      }
      expect(f.from).not.toHaveBeenCalled();
      noCommercialEffects(f, before);
    },
  );

  it.each(["handler", "mcp"] as const)(
    "humano ganha via close %s e retry é idempotente",
    async (path) => {
      const f = crmFixture();
      const call = () =>
        path === "handler"
          ? encerraDemanda(f.supabase, context(human), { leadId: ids.lead, desfecho: "won" })
          : crmCloseDemand.handler(
              { lead_id: ids.lead, outcome: "won" },
              mcpContext(f.supabase, human),
            );
      const first = await call();
      expect(first).toMatchObject(
        path === "handler"
          ? { lead: { status: "won" }, jaEstava: false }
          : { encerrado: true, status: "won", ja_estava: false },
      );
      expect(await call()).toMatchObject(
        path === "handler" ? { jaEstava: true } : { ja_estava: true },
      );
      expect(f.lead()).toMatchObject({
        status: "won",
        stage_id: ids.won,
        closed_at: expect.any(String),
      });
      expect(f.updates).toHaveBeenCalledTimes(1);
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(emitLeadActivity).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([ai, human])(
    "close de perda continua possível com motivo válido para $type",
    async (actor) => {
      const f = crmFixture();
      expect(
        await crmCloseDemand.handler(
          {
            lead_id: ids.lead,
            outcome: "lost",
            reason: "requested_by_customer",
          },
          mcpContext(f.supabase, actor),
        ),
      ).toMatchObject({ encerrado: true, status: "lost" });
      expect(f.lead()).toMatchObject({
        status: "lost",
        lost_reason: "requested_by_customer",
        stage_id: ids.lost,
      });
      expect(f.updates).toHaveBeenCalledWith(
        expect.objectContaining({ lost_reason: "requested_by_customer" }),
      );
    },
  );

  it("close sem motivo de perda continua recusado antes de efeitos", async () => {
    const f = crmFixture();
    const before = f.snapshot();
    expect(
      await crmCloseDemand.handler(
        { lead_id: ids.lead, outcome: "lost" },
        mcpContext(f.supabase, ai),
      ),
    ).toMatchObject({ encerrado: false, motivo: "validation_failed" });
    noCommercialEffects(f, before);
  });

  it.each(["handler", "mcp"] as const)(
    "IA não cria oportunidade ganha via %s, inclusive retry",
    async (path) => {
      const f = crmFixture();
      const before = f.snapshot();
      const input = { pipeline_id: ids.pipeline, stage_id: ids.won, title: "Oportunidade fixture" };
      for (let retry = 0; retry < 2; retry++) {
        const call =
          path === "handler"
            ? createLeadHandler(f.supabase, context(ai), createLeadSchema.parse(input))
            : crmCreateLead.handler(input, mcpContext(f.supabase, ai));
        await expect(call).rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
      expect(f.selections).toContain("id, pipeline_id, organization_id, is_won");
      noCommercialEffects(f, before);
    },
  );

  it.each(["handler", "mcp"] as const)(
    "humano pode criar oportunidade ganha via %s",
    async (path) => {
      const f = crmFixture();
      const input = { pipeline_id: ids.pipeline, stage_id: ids.won, title: "Oportunidade fixture" };
      const result =
        path === "handler"
          ? await createLeadHandler(f.supabase, context(human), createLeadSchema.parse(input))
          : await crmCreateLead.handler(input, mcpContext(f.supabase, human));
      expect(result).toMatchObject(
        path === "handler"
          ? { status: "won", closed_at: expect.any(String) }
          : { lead: { status: "won", closed_at: expect.any(String) } },
      );
      expect(f.leadCount()).toBe(2);
      expect(f.inserts).toHaveBeenCalledTimes(1);
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
    },
  );

  it("IA continua criando oportunidade aberta", async () => {
    const f = crmFixture();
    expect(
      await crmCreateLead.handler(
        {
          pipeline_id: ids.pipeline,
          stage_id: ids.open,
          title: "Oportunidade fixture",
        },
        mcpContext(f.supabase, ai),
      ),
    ).toMatchObject({ lead: { status: "open", stage_id: ids.open } });
    expect(f.leadCount()).toBe(2);
  });
});
