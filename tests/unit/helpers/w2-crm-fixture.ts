import { vi } from "vitest";
import type { McpContext } from "@/lib/mcp/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";

export const ids = {
  org: "11111111-1111-4111-8111-111111111111",
  pipeline: "22222222-2222-4222-8222-222222222222",
  lead: "33333333-3333-4333-8333-333333333333",
  won: "44444444-4444-4444-8444-444444444444",
  lost: "55555555-5555-4555-8555-555555555555",
  open: "66666666-6666-4666-8666-666666666666",
  old: "77777777-7777-4777-8777-777777777777",
};
export const ai: Actor = { type: "ai_agent", id: "agent-fixture", role: "manager" };
export const human: Actor = { type: "user", id: "user-fixture", role: "manager" };
export const context = (actor: Actor): HandlerCtx => ({
  organization_id: ids.org,
  actor,
  requestId: "request-fixture",
});
export function mcpContext(supabase: McpContext["supabase"], actor: Actor): McpContext {
  return {
    supabase,
    actor,
    organizationId: ids.org,
    role: "manager",
    apiTokenId: "token-fixture",
    requestId: "request-fixture",
  };
}

/**
 * Fixture em memória, NÃO banco real nem prova de RLS.
 * Aplica filtros e o contrato mínimo de status/closed_at/lost_reason do baseline,
 * para não aceitar perdas que os fakes antigos aceitavam incorretamente.
 */
export function crmFixture(
  options: {
    initialStatus?: "open" | "won";
    lostReason?: string | null;
    stageOrg?: string;
    stagePipeline?: string;
  } = {},
) {
  type Row = Record<string, unknown>;
  const stages: Row[] = [ids.won, ids.lost, ids.open, ids.old].map((id) => ({
    id,
    organization_id: options.stageOrg ?? ids.org,
    pipeline_id: options.stagePipeline ?? ids.pipeline,
    name: id === ids.won ? "Desfecho com nome arbitrário" : "Etapa comum",
    is_won: id === ids.won,
    is_lost: id === ids.lost,
    agent_stage_hint: null,
  }));
  const leads: Row[] = [
    {
      id: ids.lead,
      organization_id: ids.org,
      pipeline_id: ids.pipeline,
      stage_id: options.initialStatus === "won" ? ids.won : ids.old,
      status: options.initialStatus ?? "open",
      contact_id: null,
      position_in_stage: 1000,
      lost_reason: options.lostReason ?? null,
      closed_at: options.initialStatus === "won" ? "2026-09-18T00:00:00Z" : null,
      updated_at: "2026-09-18T00:00:00Z",
    },
  ];
  const updates = vi.fn();
  const inserts = vi.fn();
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const selections: string[] = [];

  function applyStage(row: Row): Row {
    const stage = stages.find((s) => s.id === row.stage_id);
    const result = { ...row };
    if (stage?.is_won || stage?.is_lost) {
      result.status = stage.is_won ? "won" : "lost";
      result.closed_at ??= "2026-09-18T01:00:00Z";
    }
    if (result.status === "lost") {
      if (!result.lost_reason) throw new Error("lost_reason_required");
      if (!(CANONICAL_LOST_REASONS as readonly unknown[]).includes(result.lost_reason)) {
        throw new Error("lost_reason_invalid");
      }
    }
    return result;
  }

  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    let inserted: Row | null = null;
    let maximum: number | null = null;
    const rows = () => (table === "crm_leads" ? leads : table === "crm_stages" ? stages : []);
    function execute(single: boolean) {
      try {
        let matches = rows().filter((row) => filters.every(([key, value]) => row[key] === value));
        if (inserted) {
          const row = applyStage({ id: "88888888-8888-4888-8888-888888888888", ...inserted });
          leads.push(row);
          matches = [row];
        } else if (patch) {
          const replacements = matches.map((row) => applyStage({ ...row, ...patch }));
          matches.forEach((row, index) => Object.assign(row, replacements[index]));
        }
        if (maximum !== null) matches = matches.slice(0, maximum);
        const data = matches.map((row) => ({ ...row }));
        return { data: single ? (data[0] ?? null) : data, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    }
    const builder = {
      select: (columns: string) => {
        selections.push(columns);
        return builder;
      },
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        maximum = n;
        return builder;
      },
      update: (value: Row) => {
        updates(value);
        patch = value;
        return builder;
      },
      insert: (value: Row) => {
        inserts(value);
        inserted = value;
        return builder;
      },
      maybeSingle: async () => execute(true),
      single: async () => execute(true),
      then: (resolve: (value: ReturnType<typeof execute>) => unknown) =>
        Promise.resolve(execute(false)).then(resolve),
    };
    return builder;
  });
  return {
    supabase: { from, rpc } as unknown as McpContext["supabase"],
    from,
    rpc,
    updates,
    inserts,
    selections,
    snapshot: () => JSON.stringify(leads),
    lead: () => ({ ...leads[0]! }),
    leadCount: () => leads.length,
  };
}
