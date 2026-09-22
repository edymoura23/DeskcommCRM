import { describe, expect, it, vi } from "vitest";

const sends: Array<Record<string, unknown>> = [];
vi.mock("@/lib/channels", async (original) => {
  const real = await original();
  return {
    ...real,
    getAdapter: (provider: string) => ({
      provider,
      codes: { notConfigured: `${provider}_not_configured`, sendFailed: `${provider}_error`, unknownError: `${provider}_unknown` },
      isConfigured: () => true,
      resolveRecipient: (input: { phoneNumber?: string | null }) => input.phoneNumber?.replace(/\D/g, "") ?? null,
      send: async (envelope: Record<string, unknown>) => {
        sends.push(envelope);
        return { externalId: `external-${String(envelope.sessionRef)}` };
      },
    }),
  };
});

import { isQueuedRedriveEligible, redriveQueuedWithAdapters } from "@/lib/channels/redrive-queued";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "m1", organization_id: "org-a", body: "oi", sent_via: "ai",
    redrive_contract: "adapter_v1", provider: "meta_cloud",
    waha_session_name: null, meta_phone_number_id: "pn-a", zernio_account_id: null,
    provider_conversation_id: null, wa_identity: null, wa_lid: null,
    phone_number: "+551100000001", is_group: false, group_chat_id: null, ...over,
  };
}

function pool(rows: Record<string, unknown>[], claim = true) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  return {
    queries,
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("select m.id")) return { rows };
      if (text.includes("returning id")) return { rows: claim ? [{ id: rows[0]?.id }] : [] };
      return { rows: [] };
    },
  };
}

const cfg = { redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0 };

describe("redrive queued pelo adapter", () => {
  it("mantém organização e sessão originais sem cruzar credenciais", async () => {
    sends.length = 0;
    const db = pool([row(), row({ id: "m2", organization_id: "org-b", meta_phone_number_id: "pn-b", phone_number: "+552200000002" })]);
    expect(await redriveQueuedWithAdapters(db as never, cfg, log)).toBe(2);
    expect(sends).toEqual([
      expect.objectContaining({ organizationId: "org-a", sessionRef: "pn-a", to: "551100000001" }),
      expect.objectContaining({ organizationId: "org-b", sessionRef: "pn-b", to: "552200000002" }),
    ]);
  });

  it("claim perdido impede envio duplicado", async () => {
    sends.length = 0;
    const db = pool([row()], false);
    expect(await redriveQueuedWithAdapters(db as never, cfg, log)).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it("consulta exige marcador novo para Meta e mantém legado WAHA", async () => {
    const db = pool([]);
    await redriveQueuedWithAdapters(db as never, cfg, log);
    const sql = db.queries[0]!.text;
    expect(sql).toContain("transport_redrive_contract");
    expect(sql).toContain("s.provider = 'waha'");
    expect(sql).toContain("m.sent_via = 'ai'");
    expect(sql).toContain("m.direction = 'outbound'");
    expect(sql).toContain("m.external_id is null");
  });

  it("WAHA legado continua atravessando o mesmo seam de adapter", async () => {
    sends.length = 0;
    const db = pool([
      row({
        provider: "waha",
        meta_phone_number_id: null,
        waha_session_name: "sessao-legada",
        wa_identity: "phone:+5511999999999",
      }),
    ]);

    expect(await redriveQueuedWithAdapters(db as never, cfg, log)).toBe(1);
    expect(sends[0]).toEqual(
      expect.objectContaining({ organizationId: "org-a", sessionRef: "sessao-legada" }),
    );
  });

  it("as 17 filas Meta históricas sem marcador permanecem congeladas", () => {
    const historicas = Array.from({ length: 17 }, (_, i) => ({
      provider: "meta_cloud" as const,
      sentVia: "ai",
      redriveContract: null,
      id: `historica-${i + 1}`,
    }));

    expect(
      historicas.filter((m) => isQueuedRedriveEligible(m)),
      "nenhuma fila Meta anterior ao contrato adapter_v1 pode entrar no redrive",
    ).toEqual([]);
    expect(
      isQueuedRedriveEligible({ provider: "meta_cloud", sentVia: "ai", redriveContract: "adapter_v1" }),
    ).toBe(true);
  });
});
