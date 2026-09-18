import { describe, expect, it, vi } from "vitest";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { mintEphemeralToken, revokeEphemeralToken } from "@/lib/ai/runtime/mcp_token";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import type { Logger } from "@/lib/agent-engine/obs/logger";

vi.mock("@/lib/ai/runtime/tools", () => ({
  pickToolsFromMcp: vi.fn(() => ({ crm_move_lead_stage: {} })),
}));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: vi.fn(async () => ({ id: "token-fixture" })),
  revokeEphemeralToken: vi.fn(async () => undefined),
}));

describe("W2 — identidade IA na ponte do engine", () => {
  it("preserva ai_agent no contexto e auth, sem elevar para humano", async () => {
    const config = {
      agentId: "agent-fixture",
      toolIds: ["crm_move_lead_stage"],
      pipelineIds: ["pipeline-fixture"],
    } as PublishedAgentConfig;
    const edge = { supabase: {} } as CrmEdgeConfig;
    const log = { warn: vi.fn() } as unknown as Logger;
    const result = await buildMcpTurnTools(
      edge,
      { organizationId: "org-fixture", jobId: "job-fixture" },
      config,
      log,
    );
    expect(mintEphemeralToken).toHaveBeenCalledOnce();
    const input = vi.mocked(pickToolsFromMcp).mock.calls[0]![0];
    expect(input.ctx.actor).toMatchObject({
      type: "ai_agent",
      id: "agent-fixture",
      agent_id: "agent-fixture",
      api_token_id: "token-fixture",
    });
    expect(input.auth.actor).toEqual(input.ctx.actor);
    expect(input.ctx.role).toBe("ai_operator");
    expect(input.auth.role).toBe("ai_operator");
    await result!.cleanup();
    expect(revokeEphemeralToken).toHaveBeenCalledWith("token-fixture");
  });
});
