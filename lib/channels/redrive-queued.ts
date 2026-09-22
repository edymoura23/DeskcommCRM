import type pg from "pg";

import { getAdapter, resolveSessionRef, type ChannelProvider, type ChannelSessionRef } from "@/lib/channels";
import type { Logger } from "@/lib/agent-engine/obs/logger";

export interface QueuedRedriveConfig {
  redriveMinAgeMs: number;
  redriveBatchSize: number;
  redriveSpacingMs: number;
}

interface QueuedRow {
  id: string;
  organization_id: string;
  body: string | null;
  sent_via: string | null;
  redrive_contract: string | null;
  provider: ChannelProvider;
  waha_session_name: string | null;
  meta_phone_number_id: string | null;
  zernio_account_id: string | null;
  provider_conversation_id: string | null;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

export function isQueuedRedriveEligible(input: {
  provider: ChannelProvider;
  sentVia: string | null;
  redriveContract: string | null;
}): boolean {
  return input.redriveContract === "adapter_v1" || (input.provider === "waha" && input.sentVia === "ai");
}

function sessionOf(row: QueuedRow): ChannelSessionRef | null {
  if (row.provider === "waha" && row.waha_session_name) {
    return { provider: "waha", waha_session_name: row.waha_session_name };
  }
  if (row.provider === "meta_cloud" && row.meta_phone_number_id) {
    return { provider: "meta_cloud", meta_phone_number_id: row.meta_phone_number_id };
  }
  if (row.provider === "zernio" && row.zernio_account_id) {
    return { provider: "zernio", zernio_account_id: row.zernio_account_id };
  }
  return null;
}

/**
 * Redrive pelo seam de adapters. O marcador `adapter_v1` é a fronteira de
 * ativação: filas Meta anteriores ao patch não são capturadas retroativamente.
 * WAHA mantém a elegibilidade histórica para não regredir o watchdog existente.
 */
export async function redriveQueuedWithAdapters(
  pool: pg.Pool,
  cfg: QueuedRedriveConfig,
  log: Logger,
): Promise<number> {
  const { rows } = await pool.query<QueuedRow>(
    `select m.id, m.organization_id, m.body, m.sent_via,
            m.metadata->>'transport_redrive_contract' as redrive_contract, s.provider,
            s.waha_session_name, s.meta_phone_number_id, s.zernio_account_id,
            v.provider_conversation_id, c.wa_identity, c.wa_lid,
            c.phone_number, v.is_group, v.group_chat_id
       from messages m
       join channel_sessions s on s.id = m.channel_session_id
       join conversations v on v.id = m.conversation_id
       join contacts c on c.id = m.contact_id
      where m.direction = 'outbound' and m.status = 'queued'
        and m.type = 'text' and m.external_id is null
        and s.status = 'WORKING' and c.is_blocked = false
        and ((s.provider = 'waha' and m.sent_via = 'ai')
             or m.metadata->>'transport_redrive_contract' = 'adapter_v1')
        and m.created_at < now() - make_interval(secs => $1 / 1000.0)
      order by m.created_at
      limit $2`,
    [cfg.redriveMinAgeMs, cfg.redriveBatchSize],
  );

  let sent = 0;
  for (const row of rows) {
    // Defesa em profundidade além do WHERE: mesmo uma regressão futura na
    // consulta não torna fila Meta histórica elegível sem o marcador.
    if (!isQueuedRedriveEligible({
      provider: row.provider,
      sentVia: row.sent_via,
      redriveContract: row.redrive_contract,
    })) continue;
    const session = sessionOf(row);
    const adapter = getAdapter(row.provider);
    const recipient = adapter.resolveRecipient({
      isGroup: row.is_group,
      groupChatId: row.group_chat_id,
      phoneNumber: row.phone_number,
      waIdentity: row.wa_identity,
      waLid: row.wa_lid,
    });
    if (!session || !recipient || row.body === null) {
      log.warn("watchdog: queued sem sessão/destino/corpo — pulada", { message_id: row.id });
      continue;
    }

    // Claim atômico. Dois workers/ticks não podem submeter a mesma intenção.
    const claimed = await pool.query<{ id: string }>(
      `update messages
          set status = 'sending',
              metadata = coalesce(metadata, '{}'::jsonb) || '{"redrive":"adapter_v1"}'::jsonb
        where id = $1 and organization_id = $2 and status = 'queued'
          and external_id is null
          and ($3::boolean or metadata->>'transport_redrive_contract' = 'adapter_v1')
      returning id`,
      [row.id, row.organization_id, row.provider === "waha"],
    );
    if (!claimed.rows[0]) continue;

    try {
      const { externalId } = await adapter.send({
        organizationId: row.organization_id,
        sessionRef: resolveSessionRef(session),
        to: recipient,
        providerConversationId: row.provider_conversation_id,
        kind: "text",
        body: row.body,
      });
      if (!externalId) throw new Error(`${adapter.codes.sendFailed}: provider não confirmou external_id`);

      // Uma única instrução mantém mensagem + ledger no mesmo commit mesmo
      // quando `pool.query` escolher conexões diferentes entre chamadas.
      await pool.query(
        `with enviada as (
           update messages
              set status = 'sent', ack = 0, external_id = $3,
                  error_code = null, error_message = null,
                  metadata = coalesce(metadata, '{}'::jsonb) - 'queued_reason'
            where id = $1 and organization_id = $2 and status = 'sending'
          returning id
         )
         update send_ledger
            set status = 'accepted', last_error = null, updated_at = now()
          where organization_id = $2 and crm_message_id in (select id from enviada)
            and status = 'queued'`,
        [row.id, row.organization_id, externalId],
      );
      sent += 1;
      log.info("watchdog: mensagem queued submetida pelo adapter", { message_id: row.id });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const semCredencial = message.startsWith(adapter.codes.notConfigured);
      const podeRetentar = semCredencial || row.provider === "waha";
      await pool.query(
        `update messages
            set status = $3,
                error_code = case when $3 = 'failed' then $4 else null end,
                error_message = case when $3 = 'failed' then $5 else null end,
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('queued_reason', $6::text)
          where id = $1 and organization_id = $2 and status = 'sending'`,
        [
          row.id,
          row.organization_id,
          podeRetentar ? "queued" : "failed",
          adapter.codes.sendFailed,
          message,
          semCredencial ? adapter.codes.notConfigured : "redrive_provider_error",
        ],
      );
      log.warn("watchdog: redrive pelo adapter não confirmou envio", {
        message_id: row.id,
        retryable: podeRetentar,
      });
    }

    await new Promise((resolve) =>
      setTimeout(resolve, cfg.redriveSpacingMs + Math.random() * cfg.redriveSpacingMs),
    );
  }
  return sent;
}
