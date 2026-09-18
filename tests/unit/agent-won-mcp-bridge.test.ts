import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { revokeEphemeralToken } from "@/lib/ai/runtime/mcp_token";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type * as ActivityEmitter from "@/lib/leads/activity-emitter";
import { ai, human, ids, mcpContext, crmFixture } from "./helpers/w2-crm-fixture";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", async (original) => ({
  ...(await original<typeof ActivityEmitter>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true, activityId: "activity-fixture" })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn() }));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: vi.fn(async () => ({ id: "token-fixture" })),
  revokeEphemeralToken: vi.fn(async () => undefined),
}));

const cases = [
  { name: "crm_move_lead_stage", args: { lead_id: ids.lead, to_stage_id: ids.won } },
  { name: "crm_close_demand", args: { lead_id: ids.lead, outcome: "won" } },
  {
    name: "crm_create_lead",
    args: { pipeline_id: ids.pipeline, stage_id: ids.won, title: "Oportunidade fixture" },
  },
];

function execute(tools: ReturnType<typeof pickToolsFromMcp>, name: string, args: unknown) {
  const fn = tools[name]?.execute;
  if (!fn) throw new Error("Tool não foi montada: " + name);
  return (fn as (input: unknown, options: unknown) => Promise<unknown>)(args, {
    toolCallId: "call-fixture",
    messages: [],
  });
}

function assertRefusal(result: unknown, name: string) {
  expect(result).toMatchObject(
    name === "crm_close_demand"
      ? { encerrado: false, motivo: "forbidden" }
      : { error: expect.stringContaining("humana") },
  );
}

function noCommercialEffects(f: ReturnType<typeof crmFixture>, before: string) {
  expect(f.snapshot()).toBe(before);
  expect(f.updates).not.toHaveBeenCalled();
  expect(f.inserts).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(emitLeadActivity).not.toHaveBeenCalled();
  // A ponte REAL usa auditMcpToolCall; apenas seu sink é mockado.
  const calls = vi.mocked(audit).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const [entry] of calls) {
    expect(entry).toMatchObject({
      action: "mcp.tool_called",
      metadata: { actor_type: "ai_agent" },
    });
  }
}

describe("W2 — ponte MCP real, catálogo, RBAC, escopo e auditoria", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(cases)(
    "engine real recusa $name e conserva auditoria, inclusive retry",
    async ({ name, args }) => {
      const f = crmFixture();
      const before = f.snapshot();
      const config = {
        agentId: "agent-fixture",
        toolIds: [name],
        pipelineIds: [ids.pipeline],
      } as PublishedAgentConfig;
      const log = { warn: vi.fn() } as unknown as Logger;
      const result = await buildMcpTurnTools(
        { supabase: f.supabase },
        { organizationId: ids.org, jobId: "job-fixture" },
        config,
        log,
      );
      expect(result).not.toBeNull();
      for (let retry = 0; retry < 2; retry++) {
        assertRefusal(await execute(result!.tools, name, args), name);
      }
      noCommercialEffects(f, before);
      expect(audit).toHaveBeenCalledTimes(2);
      await result!.cleanup();
      expect(revokeEphemeralToken).toHaveBeenCalledWith("token-fixture");
    },
  );

  it.each(cases)("manager da IA não contorna $name na ponte real", async ({ name, args }) => {
    const f = crmFixture();
    const before = f.snapshot();
    const ctx = mcpContext(f.supabase, ai);
    const tools = pickToolsFromMcp({
      supabase: f.supabase,
      ctx,
      auth: {
        organizationId: ids.org,
        role: "manager",
        actor: ai,
        apiTokenId: "token-fixture",
        scopes: ["mcp:read", "mcp:write", "actor:ai_agent"],
      },
      toolIds: [name],
      pipelineIds: [ids.pipeline],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });
    assertRefusal(await execute(tools, name, args), name);
    noCommercialEffects(f, before);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it.each(cases)(
    "humano autorizado ainda ganha via $name na ponte real",
    async ({ name, args }) => {
      const f = crmFixture();
      const ctx = mcpContext(f.supabase, human);
      const tools = pickToolsFromMcp({
        supabase: f.supabase,
        ctx,
        auth: {
          organizationId: ids.org,
          role: "manager",
          actor: human,
          apiTokenId: "token-fixture",
          scopes: ["mcp:read", "mcp:write"],
        },
        toolIds: [name],
        pipelineIds: [ids.pipeline],
        handoffToolEnabled: false,
        handoffSignal: { triggered: false },
      });
      expect(await execute(tools, name, args)).toMatchObject(
        name === "crm_close_demand"
          ? { encerrado: true, status: "won" }
          : { lead: { status: "won" } },
      );
      expect(f.updates.mock.calls.length + f.inserts.mock.calls.length).toBe(1);
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "mcp.tool_called",
          metadata: expect.objectContaining({ actor_type: "user" }),
        }),
      );
    },
  );
});
