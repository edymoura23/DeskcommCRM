/**
 * GET /api/v1/health — relógio do follow-up (checkFollowupClock).
 *
 * A função existia no arquivo mas não era chamada pelo handler GET: o gate
 * FULL do JBA (follow-up de lead sem resposta) dependia do cron
 * `followup-flow-worker` batendo, e nada no health check acusava um relógio
 * parado (migration 0205 gravou a mecânica, mas ninguém a lia). Este teste
 * prova que o handler agora consulta `cron_heartbeats` e que os três estados
 * (ok / nunca bateu / parado) mudam o `status` agregado da rota.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    WAHA_API_BASE_URL: "",
    WAHA_API_KEY: "",
    INTERNAL_CRON_SECRET: "",
    INTERNAL_SECRET: "dev-secret",
  },
}));

function maybeSingleResult(result: { data: unknown; error: unknown }) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve(result)),
        })),
      })),
    })),
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

function req(): NextRequest {
  return new NextRequest("http://localhost/api/v1/health");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

describe("GET /api/v1/health — followup_clock", () => {
  it("cron bateu há pouco → followup_clock ok, status não fica unhealthy por causa dele", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    vi.mocked(createAdminClient).mockReturnValue(
      maybeSingleResult({ data: { last_run_at: new Date().toISOString() }, error: null }) as never,
    );

    const { GET } = await import("@/app/api/v1/health/route");
    const res = await GET(req());
    const body = (await res.json()) as { data: { checks: { followup_clock: { status: string } } } };
    expect(body.data.checks.followup_clock.status).toBe("ok");
  });

  it("cron nunca bateu → followup_clock degraded com reason relogio_parado", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    vi.mocked(createAdminClient).mockReturnValue(maybeSingleResult({ data: null, error: null }) as never);

    const { GET } = await import("@/app/api/v1/health/route");
    const res = await GET(req());
    const body = (await res.json()) as {
      data: { checks: { followup_clock: { status: string; reason?: string } } };
    };
    expect(body.data.checks.followup_clock.status).toBe("degraded");
    expect(body.data.checks.followup_clock.reason).toBe("relogio_parado");
  });

  it("cron parado (última batida há muito tempo) → followup_clock down, resposta 503 unhealthy", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    vi.mocked(createAdminClient).mockReturnValue(
      maybeSingleResult({ data: { last_run_at: staleTimestamp }, error: null }) as never,
    );

    const { GET } = await import("@/app/api/v1/health/route");
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      data: { status: string; checks: { followup_clock: { status: string; reason?: string } } };
    };
    expect(body.data.status).toBe("unhealthy");
    expect(body.data.checks.followup_clock.status).toBe("down");
    expect(body.data.checks.followup_clock.reason).toBe("relogio_parado");
  });
});
