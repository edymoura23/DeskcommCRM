/**
 * Watchdog de sessão (Fase 4A-2) — o pedaço do Vendaval que ficou de fora do
 * porte e cuja falta causou o incidente real das mensagens presas: o webhook
 * session.status se perde num restart e o espelho `channel_sessions` diverge do
 * WAHA real; como o envio exige WORKING no espelho, respostas ficam `queued`
 * para sempre.
 *
 * Três deveres, um tick:
 *   1. RECONCILIADOR: lê o status REAL das sessões na API do WAHA e corrige o
 *      espelho quando divergir (a fonte da verdade do status é o WAHA);
 *   2. RETOMA: sessão STOPPED que ainda é nossa (não arquivada) volta a subir.
 *      Restart de container, OOM e sono do Docker deixam a credencial no disco
 *      e a sessão parada — o envio exige WORKING, então inbound e auto-resposta
 *      morrem até alguém clicar Reconectar. FAILED não entra: pode ser banimento,
 *      e religar sozinho piora; SCAN_QR_CODE também não — tem gente no celular.
 *   3. REDRIVE: mensagens elegíveis presas em `queued` cuja sessão está
 *      WORKING são submetidas pelo adapter correspondente. WAHA preserva a
 *      elegibilidade legada; outros providers exigem marcador de ativação.
 *
 * Regra dura nº 4 respeitada: o watchdog delega o transporte ao mesmo seam de
 * adapters do envio normal; aqui ficam apenas reconciliação e orquestração.
 */
import type pg from 'pg';

import { redriveQueuedWithAdapters } from '@/lib/channels/redrive-queued';

import type { Logger } from '../../obs/logger';

export interface WatchdogConfig {
  wahaBaseUrl?: string;
  wahaApiKey?: string;
  /** intervalo do tick (knob WATCHDOG_INTERVAL_MS) */
  intervalMs: number;
  /** idade mínima de uma queued para redrive — evita corrida com o insert do handler */
  redriveMinAgeMs: number;
  /** teto de redrives por tick (anti-rajada) */
  redriveBatchSize: number;
  /** espaçamento entre redrives (base + jitter) */
  redriveSpacingMs: number;
}

interface WahaSession {
  name: string;
  status: string;
}

/**
 * Só STOPPED: a credencial no disco ainda vale e o start a reaproveita.
 * FAILED pode ser banimento — religar sozinho é o que o vigia de saúde recusa.
 * SCAN_QR_CODE tem alguém no celular; STARTING já está subindo.
 */
export function deveRetomarSessao(status: string): boolean {
  return status.toUpperCase() === 'STOPPED';
}

async function startWahaSession(cfg: WatchdogConfig, name: string): Promise<boolean> {
  if (!cfg.wahaBaseUrl || !cfg.wahaApiKey) return false;
  try {
    const res = await fetch(
      `${cfg.wahaBaseUrl}/api/sessions/${encodeURIComponent(name)}/start`,
      {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    // 422/409 = já está subindo ou WORKING — o efeito que queremos.
    return res.ok || res.status === 422 || res.status === 409;
  } catch {
    return false;
  }
}

async function fetchWahaSessions(cfg: WatchdogConfig): Promise<WahaSession[] | null> {
  if (!cfg.wahaBaseUrl || !cfg.wahaApiKey) return [];
  try {
    const res = await fetch(`${cfg.wahaBaseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': cfg.wahaApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WahaSession[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // WAHA fora: tick pula (transiente) — nunca derruba o worker
  }
}

/** Corrige o espelho channel_sessions para o status REAL do WAHA e retoma STOPPED. */
export async function reconcileSessions(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const sessions = await fetchWahaSessions(cfg);
  if (sessions === null) {
    log.warn('watchdog: WAHA indisponível — tick de reconciliação pulado', {});
    return 0;
  }
  let fixed = 0;
  for (const s of sessions) {
    const wahaStatus = (s.status ?? '').toUpperCase();
    // Arquivada não é nossa: a exclusão desloga o aparelho. Uma sessão STOPPED
    // órfã no transporte não pode voltar a receber mensagem num canal que a UI
    // já não mostra.
    const { rows: nossas } = await pool.query<{ id: string; status: string }>(
      // `to_jsonb(cs) ->> 'archived_at'` em vez de `cs.archived_at`, como em
      // `agent/followup-turn.ts:254` e pelo mesmo motivo: a coluna nasce na
      // migration 0106 e, num clone que subiu o código sem aplicá-la,
      // referenciá-la direto derruba o tick INTEIRO com 42703 — levando junto o
      // redrive das mensagens em fila, que roda depois desta função.
      `select cs.id, cs.status from channel_sessions cs
       where cs.waha_session_name = $1 and to_jsonb(cs) ->> 'archived_at' is null`,
      [s.name],
    );
    if (nossas.length === 0) continue;

    let nextStatus = wahaStatus;
    if (deveRetomarSessao(wahaStatus)) {
      const started = await startWahaSession(cfg, s.name);
      if (started) {
        nextStatus = 'STARTING';
        // O info sai só quando o espelho REALMENTE muda (logo abaixo, no
        // `returning`). Aqui ele sairia a cada tick de 60 s enquanto a sessão
        // continuasse parada — 1440 linhas por dia repetindo a mesma boa
        // notícia é o caminho mais curto para o operador parar de ler o log.
      }
    }

    const { rows } = await pool.query<{ id: string; status: string }>(
      `update channel_sessions
          set status = $2, updated_at = now()
        where waha_session_name = $1
          and to_jsonb(channel_sessions) ->> 'archived_at' is null
          and status is distinct from $2
       returning id, status`,
      [s.name, nextStatus],
    );
    for (const row of rows) {
      fixed += 1;
      log.warn('watchdog: espelho de sessão reconciliado com o WAHA real', {
        channel_session_id: row.id,
        waha_session: s.name,
        status: nextStatus,
      });
    }
  }
  return fixed;
}

/** Redrive transversal delegado ao seam de adapters. */
export async function redriveQueued(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  return redriveQueuedWithAdapters(pool, cfg, log);
}

/** Loop do watchdog — reconcilia e redrive a cada tick; erro nunca derruba o worker. */
export async function runSessionWatchdogLoop(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const fixed = await reconcileSessions(pool, cfg, log);
      const redriven = await redriveQueued(pool, cfg, log);
      if (fixed + redriven > 0) {
        log.info('watchdog: tick com ação', { reconciled: fixed, redriven });
      }
    } catch (err) {
      log.error('watchdog: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
