import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageHandler, completeTurnForEnrollment } = vi.hoisted(() => ({
  sendMessageHandler: vi.fn(),
  completeTurnForEnrollment: vi.fn(async () => undefined),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler }));
vi.mock("@/lib/automation/start-conversation", () => ({
  sessaoProntaParaEnvio: vi.fn(async () => "session-1"),
  ensureConversation: vi.fn(async () => "conversation-1"),
}));
vi.mock("@/lib/followup/engine", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/followup/turn-bridge", () => ({ completeTurnForEnrollment }));

import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: {
    fixed_body: "Olá",
    followup_enrollment_id: "enrollment-1",
    node_id: "node-1",
  },
};

function admin(previousStatus: string | null = null) {
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        select() {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.contains = () => chain;
          chain.order = () => chain;
          chain.limit = () =>
            table === "job_queue"
              ? Promise.resolve({ data: [JOB], error: null })
              : chain;
          chain.maybeSingle = async () => {
            if (table === "followup_enrollments") return { data: { current_node_id: "node-1" }, error: null };
            if (table === "messages") return { data: previousStatus ? { id: "message-1", status: previousStatus } : null, error: null };
            return { data: null, error: null };
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.select = () => chain;
          chain.maybeSingle = async () => ({ data: { id: JOB.id }, error: null });
          chain.then = (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve);
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

beforeEach(() => {
  sendMessageHandler.mockReset();
  completeTurnForEnrollment.mockClear();
});

describe("follow-up fixo respeita a custódia real do outbound", () => {
  it("queued volta a pending e não avança o fluxo", async () => {
    sendMessageHandler.mockResolvedValue({ id: "message-1", status: "queued" });
    const { client, updates } = admin();

    expect(await enviarTextoFixoPendente(client)).toBe(0);
    expect(updates).toContainEqual({ table: "job_queue", patch: { status: "pending" } });
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
  });

  it("failed volta a pending com erro e não avança o fluxo", async () => {
    sendMessageHandler.mockResolvedValue({ id: "message-1", status: "failed", error_code: "meta_error" });
    const { client, updates } = admin();

    expect(await enviarTextoFixoPendente(client)).toBe(0);
    expect(updates.some((u) => u.patch.status === "pending" && String(u.patch.last_error).includes("meta_error"))).toBe(true);
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
  });

  it("redrive já confirmado reconcilia o job sem novo envio", async () => {
    const { client, updates } = admin("sent");

    expect(await enviarTextoFixoPendente(client)).toBe(1);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ table: "job_queue", patch: { status: "done" } });
  });
});
