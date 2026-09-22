import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const { adminClient } = vi.hoisted(() => ({ adminClient: { current: null as SupabaseClient | null } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (!adminClient.current) throw new Error("admin de teste não configurado");
    return adminClient.current;
  },
}));

import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";

function dbFor(org: string, pnid: string, token: string): SupabaseClient {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => chain;
      chain.maybeSingle = async () =>
        table === "meta_templates"
          ? {
              data: {
                name: "boas_vindas",
                language: "pt_BR",
                status: "APPROVED",
                contract_hash: "hash",
                components: [{ type: "BODY", text: "Olá" }],
              },
              error: null,
            }
          : {
              data: { organization_id: org, meta_phone_number_id: pnid, meta_token_encrypted: "\\x01" },
              error: null,
            };
      return chain;
    },
    rpc: vi.fn(async () => ({ data: token, error: null })),
  } as unknown as SupabaseClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  adminClient.current = null;
});

describe("template Meta usa a credencial da sessão", () => {
  it.each([
    ["org-a", "pn-a", "token-a", "wamid.a"],
    ["org-b", "pn-b", "token-b", "wamid.b"],
  ])("%s envia exclusivamente por sua sessão", async (org, pnid, token, wamid) => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "pn-global");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "token-global");
    const fetchMock = vi.fn(async () => Response.json({ messages: [{ id: wamid }] }));
    vi.stubGlobal("fetch", fetchMock);

    const db = dbFor(org, pnid, token);
    adminClient.current = db;
    const result = await sendTemplateForSession(db, {
      organizationId: org,
      sessionRef: pnid,
      to: "5511999999999",
      name: "boas_vindas",
      language: "pt_BR",
      values: {},
    });

    expect(result).toBe(wamid);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/${pnid}/messages`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect((init?.headers as Record<string, string>).Authorization).not.toContain("global");
  });
});
