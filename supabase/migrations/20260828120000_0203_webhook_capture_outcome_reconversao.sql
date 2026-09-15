-- 0203 · webhook_lead_captures.outcome passa a aceitar 'reconversao'.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- A rota de captação pública (POST /api/v1/webhooks/in/[token]) passou a
-- reconhecer RE-CONVERSÃO: o MESMO contato convertendo de novo (webhook/
-- formulário) no MESMO funil e MESMO `conversion_identifier`, com um lead já
-- ABERTO daquela demanda. Nesse caso a rota NÃO cria um card novo — registra a
-- conversão como atividade (`webhook_reconversion`) no lead existente,
-- preservando o `event_uuid` para idempotência, e grava a captação com este
-- desfecho novo.
--
-- ─── Por que um valor novo, e não 'duplicado' ──────────────────────────────
-- 'duplicado' já tem dono semântico: é o RETRY da ferramenta integradora
-- (mesmo `external_id` reenviado por timeout). "A pessoa converteu outra vez"
-- e "a ferramenta reenviou o mesmo POST" são acontecimentos diferentes para
-- quem lê a tela "Leads recebidos" — colapsá-los esconderia interesse real do
-- lead atrás de uma palavra que significa "ignore, é ruído".
--
-- ─── Segurança da constraint ───────────────────────────────────────────────
-- Widening puro: acrescenta um valor permitido. NENHUMA linha existente pode
-- violar a constraint nova, então não há dado a corrigir antes (doutrina de
-- migrations, item 8 — não se aplica aqui porque a mudança só amplia).
--
-- Idempotente: `drop constraint if exists` + `add constraint`. Reaplicar em
-- banco já migrado apenas recria a mesma constraint. Portável em psql puro —
-- sem BEGIN/COMMIT explícito (o runner envolve), sem temp table.
--
-- O CHECK nasceu inline no `create table` (baseline.sql), então o nome é o que
-- o Postgres gera para constraint de coluna anônima: `<tabela>_<coluna>_check`.

alter table public.webhook_lead_captures
  drop constraint if exists webhook_lead_captures_outcome_check;

alter table public.webhook_lead_captures
  add constraint webhook_lead_captures_outcome_check
  check (outcome in ('criado', 'duplicado', 'recusado', 'reconversao'));

comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = mesmo external_id já capturado antes (retry da ferramenta); recusado = não entrou (reject_reason diz por quê); reconversao = o mesmo contato converteu de novo no mesmo funil/identificador havendo lead aberto — sem card novo, a conversão virou atividade no lead existente.';
