import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as ChannelsModule from "@/lib/channels";

const { sends } = vi.hoisted(() => ({ sends: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/channels", async (original) => {
  const real = await original<typeof ChannelsModule>();
  return {
    ...real,
    getAdapter: () => ({
      provider: "meta_cloud",
      codes: { notConfigured: "meta_not_configured", sendFailed: "meta_error", unknownError: "meta_unknown" },
      isConfigured: () => true,
      resolveRecipient: (input: { phoneNumber?: string | null }) => input.phoneNumber?.replace(/\D/g, "") ?? null,
      send: async (envelope: Record<string, unknown>) => {
        sends.push(envelope);
        return { externalId: `wamid.${String(envelope.sessionRef)}` };
      },
    }),
  };
});

import { redriveQueuedWithAdapters } from "@/lib/channels/redrive-queued";
import { createLogger } from "@/lib/agent-engine/obs/logger";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via pnpm test:db");
const port = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 2 });
const log = createLogger();

const ORG_A = "ca000000-0000-4000-8000-000000000001";
const ORG_B = "cb000000-0000-4000-8000-000000000001";
const SESSION_A = "ca000000-0000-4000-8000-000000000002";
const SESSION_B = "cb000000-0000-4000-8000-000000000002";
const CONTACT_A = "ca000000-0000-4000-8000-000000000003";
const CONTACT_B = "cb000000-0000-4000-8000-000000000003";
const CONV_A = "ca000000-0000-4000-8000-000000000004";
const CONV_B = "cb000000-0000-4000-8000-000000000004";
const NEW_A = "ca000000-0000-4000-8000-000000000005";
const NEW_B = "cb000000-0000-4000-8000-000000000005";

beforeAll(async () => {
  for (const [org, slug] of [[ORG_A, "meta-redrive-a"], [ORG_B, "meta-redrive-b"]]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4)`,
      [org, slug, slug, slug],
    );
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values
       ($1, $2, 'A', '+551100000001'), ($3, $4, 'B', '+552200000002')`,
    [CONTACT_A, ORG_A, CONTACT_B, ORG_B],
  );
  await pool.query(
    `insert into channel_sessions
       (id, organization_id, provider, meta_phone_number_id, status, webhook_secret_encrypted)
     values ($1, $2, 'meta_cloud', 'pn-a', 'WORKING', '\\x00'::bytea),
            ($3, $4, 'meta_cloud', 'pn-b', 'WORKING', '\\x00'::bytea)`,
    [SESSION_A, ORG_A, SESSION_B, ORG_B],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false), ($5, $6, $7, $8, 'open', false)`,
    [CONV_A, ORG_A, CONTACT_A, SESSION_A, CONV_B, ORG_B, CONTACT_B, SESSION_B],
  );
  await pool.query(
    `insert into messages
       (id, organization_id, conversation_id, channel_session_id, contact_id,
        type, direction, status, body, sent_via, sent_at, metadata)
     values ($1, $2, $3, $4, $5, 'text', 'outbound', 'queued', 'nova a', 'ai', now() - interval '1 minute',
             '{"transport_redrive_contract":"adapter_v1"}'),
            ($6, $7, $8, $9, $10, 'text', 'outbound', 'queued', 'nova b', 'ai', now() - interval '1 minute',
             '{"transport_redrive_contract":"adapter_v1"}')`,
    [NEW_A, ORG_A, CONV_A, SESSION_A, CONTACT_A, NEW_B, ORG_B, CONV_B, SESSION_B, CONTACT_B],
  );
  for (let i = 0; i < 17; i += 1) {
    await pool.query(
      `insert into messages
         (organization_id, conversation_id, channel_session_id, contact_id,
          type, direction, status, body, sent_via, sent_at, metadata)
       values ($1, $2, $3, $4, 'text', 'outbound', 'queued', $5, 'ai', now() - interval '1 minute', '{}')`,
      [ORG_A, CONV_A, SESSION_A, CONTACT_A, `historica-${i + 1}`],
    );
  }
});

afterAll(async () => pool.end());

describe("redrive Meta transversal", () => {
  it("usa organização/sessão da própria linha e congela as 17 históricas", async () => {
    sends.length = 0;
    const count = await redriveQueuedWithAdapters(
      pool,
      { redriveMinAgeMs: 0, redriveBatchSize: 50, redriveSpacingMs: 0 },
      log,
    );
    expect(count).toBe(2);
    expect(sends).toEqual([
      expect.objectContaining({ organizationId: ORG_A, sessionRef: "pn-a", to: "551100000001" }),
      expect.objectContaining({ organizationId: ORG_B, sessionRef: "pn-b", to: "552200000002" }),
    ]);

    const { rows: novas } = await pool.query(
      `select id, status, external_id from messages where id = any($1::uuid[]) order by id`,
      [[NEW_A, NEW_B]],
    );
    expect(novas).toEqual([
      { id: NEW_A, status: "sent", external_id: "wamid.pn-a" },
      { id: NEW_B, status: "sent", external_id: "wamid.pn-b" },
    ]);
    const { rows: historicas } = await pool.query(
      `select count(*)::int as n from messages where body like 'historica-%' and status = 'queued' and external_id is null`,
    );
    expect(historicas[0]?.n).toBe(17);
  });
});
