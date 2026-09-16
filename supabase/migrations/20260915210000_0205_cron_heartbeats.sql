-- 0205 — o relógio do sistema pode parar sem que nenhuma tela avise.
--
-- Medido no JBA (investigação de 2026-09-15, seguindo os fixes de silence-sweep
-- e reactiveInbound de 2026-09-08/09-15): o ciclo inteiro de atendimento que
-- depende de PASSAGEM DE TEMPO — follow-up por silêncio, retomada pós-handoff,
-- roteamento — depende de ALGUMA COISA batendo o job `followup-flow-worker` a
-- cada ~1min. Existem DOIS motores possíveis, e não um só: no self-host é o
-- cron dedicado (`app/api/v1/cron/followup-flow-worker/route.ts`, chamado
-- pelo container `scheduler`); no Vercel Hobby — sem esse container, o caso
-- real do JBA (docs/current-state.md, docs/testing/user-journey-map.md J18)
-- — é `/api/v1/system/relogio/tick` (`lib/relogio/executar.ts`), batido por
-- cron externo (GitHub Actions / cron-job.org). Se NENHUM dos dois bate,
-- NADA acusa: não há audit (tick que não roda não emite nada), não há log,
-- não há tela. O sistema fica em silêncio absoluto sobre o próprio silêncio
-- — violação direta de "nenhuma demanda sem próximo passo" e "log universal
-- e visível" no nível da própria infraestrutura de follow-up.
--
-- `cron_heartbeats` é o batimento cru: toda batida de QUALQUER UM dos dois
-- motores grava `last_run_at` na MESMA chave (`job_name = 'followup-flow-worker'`),
-- INDEPENDENTE de ter havido efeito (é o oposto do audit log, que só registra
-- tick com efeito de propósito — CLAUDE.md, seção Audit log). Consumido por
-- `/api/v1/health` (checkFollowupClock) para acusar relógio parado como
-- `degraded`/`down` com `reason: 'relogio_parado'` — sem presumir qual dos
-- dois motores deveria estar de pé numa instalação dada.
--
-- Não é tenant-aware (é liveness de processo, não dado de organização) —
-- RLS habilitada sem nenhuma policy = deny-by-default para anon/authenticated;
-- só service_role (que bypassa RLS) lê/escreve.
create table if not exists public.cron_heartbeats (
  job_name text primary key,
  last_run_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.cron_heartbeats enable row level security;

revoke all on public.cron_heartbeats from anon, authenticated;
