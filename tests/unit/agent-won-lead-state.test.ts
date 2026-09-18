import { describe, expect, it, vi } from "vitest";
import { applyLeadStateUpdate, type LeadStateRow } from "@/lib/agent-engine/agent/lead-state";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ids = { tenantId: "org-fixture", leadId: "contact-fixture" };
function state(stage: LeadStateRow["stage"]): LeadStateRow {
  return {
    id: "state-fixture",
    organization_id: ids.tenantId,
    contact_id: ids.leadId,
    stage,
    qualification: {},
    next_action: null,
    next_action_seq: 0,
    updated_at: new Date(0),
  };
}

describe("W2 — update_lead_state", () => {
  it("recusa won antes de qualquer consulta, mutação ou histórico", async () => {
    const query = vi.fn();
    const result = await applyLeadStateUpdate({ query } as unknown as Queryable, ids, {
      stage: "won",
      qualification: { budget: "fixture" },
      next_action: "fixture",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "human_sale_required" } });
    if (!result.ok) expect(result.error.message).toContain("humana");
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["new", "contacted"],
    ["qualified", "negotiating"],
    ["new", "lost"],
    ["negotiating", "lost"],
  ] as const)("preserva movimento permitido %s → %s", async (from, to) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [state(from)] })
      .mockResolvedValueOnce({ rows: [state(to)] });
    const result = await applyLeadStateUpdate({ query } as unknown as Queryable, ids, {
      stage: to,
    });
    expect(result).toMatchObject({ ok: true, transition: { from, to } });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![1]).toEqual(expect.arrayContaining([ids.tenantId, ids.leadId, to]));
  });

  it("continua rejeitando regressão", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [state("negotiating")] });
    expect(
      await applyLeadStateUpdate({ query } as unknown as Queryable, ids, { stage: "new" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("mantém leitura e atualização de qualificação em estado won histórico", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [state("won")] });
    expect(
      await applyLeadStateUpdate({ query } as unknown as Queryable, ids, {
        qualification: { need: "fixture" },
      }),
    ).toMatchObject({ ok: true, state: { stage: "won" }, transition: null });
  });
});

describe("W2 — retry/no-op do estado do agente", () => {
  it.each(["negotiating", "won"] as const)(
    "stage won é recusado com estado fixture %s, inclusive retry",
    async (stage) => {
      const query = vi.fn().mockResolvedValue({ rows: [state(stage)] });
      for (let retry = 0; retry < 2; retry++) {
        expect(
          await applyLeadStateUpdate({ query } as unknown as Queryable, ids, { stage: "won" }),
        ).toMatchObject({ ok: false, error: { code: "human_sale_required" } });
      }
      expect(query).not.toHaveBeenCalled();
    },
  );
});
