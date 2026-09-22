import { describe, expect, it, vi } from "vitest";

import { applySendOutcome } from "@/lib/agent-engine/edge/crm/send-message";

describe("disposição de queued no agent-engine", () => {
  it("reagenda sem consumir attempts e não declara sucesso", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "job-1", status: "pending", attempts: 0 }],
    }));
    const db = { query } as never;

    const result = await applySendOutcome(
      db,
      { kind: "queued", idempotencyKey: "ledger-1", crmMessageId: "message-1" },
      { jobId: "job-1", workerId: "worker-1", tenantId: "org-1", leadId: "lead-1" },
      { queuedRetryDelayMs: 30_000 },
    );

    expect(result).toMatchObject({ action: "requeued", job: { status: "pending" } });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("attempts = greatest(attempts - 1, 0)");
    expect(values).toEqual(["job-1", "worker-1", 30_000, expect.stringContaining("queued")]);
  });

  it("sent permanece sob responsabilidade do encerramento normal do worker", async () => {
    const query = vi.fn();
    const result = await applySendOutcome(
      { query } as never,
      { kind: "sent", idempotencyKey: "ledger-1", crmMessageId: "message-1" },
      { jobId: "job-1", workerId: "worker-1", tenantId: "org-1", leadId: "lead-1" },
      { queuedRetryDelayMs: 30_000 },
    );
    expect(result).toEqual({ action: "none" });
    expect(query).not.toHaveBeenCalled();
  });
});
