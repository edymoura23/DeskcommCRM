-- 0204 — visibilidade de CONTATO (e tabelas-irmãs com PII) por atribuição, e a
--        trava que impede o corretor comum de tirar a conversa da IA / furar a fila.
--
-- ============================================================================
-- POR QUÊ
-- ============================================================================
-- O `visibility_mode` ('all' | 'own_and_unassigned' | 'own') das migrations
-- 0035/0036 restringe o SELECT de conversations/messages/crm_leads/
-- crm_lead_activities/crm_lead_links para o papel `agent`. Mas ele PARA aí. A
-- tabela `contacts` — nome, telefone, e-mail, cpf_hash, birthdate — só tem RLS
-- de organização (`tenant_isolation_contacts_all`, org-flat). Um corretor comum,
-- mesmo com `visibility_mode='own'`, lista e abre por id QUALQUER contato da org
-- (tela /app/contatos, GET /api/v1/contacts, GET /api/v1/contacts/[id]), busca
-- por telefone, e vê o Radar de risco org-wide (/api/v1/leads/at-risk usa admin
-- client). O mesmo vale para as irmãs com PII/rastro do cliente:
-- conversation_notes, agent_cases, demandas, crm_lead_scores,
-- crm_lead_risk_states, crm_lead_reactivations, calendar_appointments — todas
-- FOR ALL org-flat. Para um piloto CTWA (corretor externo, LGPD) isso é
-- vazamento: o corretor contata o cliente por fora do CRM antes de o lead ser
-- oficialmente entregue a ele.
--
-- Além disso, `fn_conversation_assign` (o choke point de TODA mudança de dono —
-- /claim, /transfer, /pause-ai) NÃO tem gate de papel: um `agent` comum assume
-- ('claim') uma conversa que a IA está atendendo, cala o robô e "fura a fila"
-- pegando o lead quente antes da qualificação. A regra do piloto é: manager/
-- admin atribuem; o corretor só RECEBE. Enquanto o lead não é oficialmente do
-- corretor, ele não vê nem obtém nada que identifique/contate o cliente.
--
-- ============================================================================
-- O QUE MUDA
-- ============================================================================
-- P1. `fn_can_view_contact(p_org, p_contact_id)` — primitiva irmã de
--     fn_can_view_conversation/lead. platform_admin → tudo; viewer/manager/admin
--     → org-wide (DECISÃO: viewer permanece org-wide, idêntico às duas irmãs —
--     ele não reivindica conversa nem é dono de lead, então escopo por
--     atribuição o cegaria por inteiro, e ele é read-only: não age sobre o PII
--     em sistema); papel `agent` → escopo por `visibility_mode`, onde "meu" = ter
--     conversa atribuída OU lead com owner para AQUELE contato.
-- P2. `contacts`: a FOR ALL `tenant_isolation_contacts_all` é re-expressa
--     POR-COMANDO (a armadilha G4-01: o USING de um FOR ALL governa o SELECT
--     junto, policies OR-adas). SELECT = fn_can_view_contact; escrita permanece
--     IDÊNTICA à de hoje (org OR platform_admin — inbound é service_role e
--     bypassa RLS de qualquer forma).
-- P3. As irmãs herdam o escopo do PAI, sem novo vocabulário:
--       conversation_notes, agent_cases  → EXISTS na conversa (molde messages_select)
--       crm_lead_scores/_risk_states/_reactivations → EXISTS no lead via
--                                            fn_can_view_lead (molde crm_lead_activities_select)
--       demandas, calendar_appointments   → fn_can_view_contact(contact_id)
--     Todas as FOR ALL viram por-comando; escrita inalterada.
-- P4 é TypeScript (Radar) — fora desta migration.
-- P5. `fn_conversation_assign`:
--     (a) GUARD: chamador de SESSÃO (auth.uid() não nulo) que NÃO é manager+ e
--         p_reason in ('claim','transfer') só pode agir sobre conversa que JÁ é
--         dele (v_from = auth.uid()). Senão → raise 'agent_assignment_requires_manager'.
--         'routing'/'handoff'/'release' e chamador de sistema (uid nulo →
--         cron/service_role) passam intactos. manager/admin/platform-admin passam.
--     (b) OWNER-SYNC: claim/transfer com destino não nulo "adota" o(s) lead(s)
--         aberto(s) do contato da conversa (owner_user_id := destino, trio
--         coerente com crm_leads_owner_kind_coherence) — mesma lógica que o
--         rodízio já aplica (adotarLeadsDoContato). release/transfer sem destino
--         solta o owner que era do liberador. Assim, atribuir a conversa e ver o
--         card/timeline do lead deixam de ser dois gestos.
--
-- Genérico (todo tenant ganha). Não muda contrato de API. Não implementa
-- distribuição automática pós-handoff (backlog). routing.mode segue 'manual'
-- por escolha de operação, não por esta migration.
--
-- Forward-fix aditivo das 0035/0036/0042/0070. Idempotente e auto-curativo.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- P1 — fn_can_view_contact
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_can_view_contact(
  p_org uuid,
  p_contact_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_contact_id is null then false
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then
           -- visível a menos que OUTRO atendente já tenha o contato
           -- (conversa atribuída a outro OU lead com owner de outro).
           not exists (
             select 1 from public.conversations c
              where c.organization_id = p_org
                and c.contact_id = p_contact_id
                and c.assigned_to_user_id is not null
                and c.assigned_to_user_id <> auth.uid()
           )
           and not exists (
             select 1 from public.crm_leads l
              where l.organization_id = p_org
                and l.contact_id = p_contact_id
                and l.owner_user_id is not null
                and l.owner_user_id <> auth.uid()
           )
         else -- 'own': só o contato de uma conversa OU lead oficialmente meu
           exists (
             select 1 from public.conversations c
              where c.organization_id = p_org
                and c.contact_id = p_contact_id
                and c.assigned_to_user_id = auth.uid()
           )
           or exists (
             select 1 from public.crm_leads l
              where l.organization_id = p_org
                and l.contact_id = p_contact_id
                and l.owner_user_id = auth.uid()
           )
       end
  end;
$$;

revoke all     on function public.fn_can_view_contact(uuid, uuid) from public;
revoke execute on function public.fn_can_view_contact(uuid, uuid) from anon;
grant  execute on function public.fn_can_view_contact(uuid, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- P2 — contacts: SELECT visibility-aware, escrita por-comando IDÊNTICA à de hoje
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "tenant_isolation_contacts_all" on public.contacts;
drop policy if exists "contacts_select"        on public.contacts;
drop policy if exists "contacts_agent_insert"  on public.contacts;
drop policy if exists "contacts_agent_update"  on public.contacts;
drop policy if exists "contacts_agent_delete"  on public.contacts;

create policy "contacts_select" on public.contacts
  for select using (
    public.fn_can_view_contact(organization_id, id)
  );

create policy "contacts_agent_insert" on public.contacts
  for insert with check (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
create policy "contacts_agent_update" on public.contacts
  for update using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
create policy "contacts_agent_delete" on public.contacts
  for delete using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- P3 — tabelas-irmãs herdam o escopo do pai (conversa ou lead ou contato)
-- ─────────────────────────────────────────────────────────────────────────────

-- conversation_notes: SELECT herda a conversa; a _write era FOR ALL (USING
-- governa SELECT via OR — a armadilha G4-01), re-expressa por-comando.
drop policy if exists "conversation_notes_select" on public.conversation_notes;
drop policy if exists "conversation_notes_write"  on public.conversation_notes;
drop policy if exists "conversation_notes_insert" on public.conversation_notes;
drop policy if exists "conversation_notes_update" on public.conversation_notes;
drop policy if exists "conversation_notes_delete" on public.conversation_notes;

create policy "conversation_notes_select" on public.conversation_notes
  for select using (
    public.fn_is_platform_admin()
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_notes.conversation_id
    )
  );
create policy "conversation_notes_insert" on public.conversation_notes
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  );
create policy "conversation_notes_update" on public.conversation_notes
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  );
create policy "conversation_notes_delete" on public.conversation_notes
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  );

-- agent_cases: SELECT herda a conversa (conversation_id é NOT NULL).
drop policy if exists "tenant_isolation_agent_cases_all" on public.agent_cases;
drop policy if exists "agent_cases_select" on public.agent_cases;
drop policy if exists "agent_cases_insert" on public.agent_cases;
drop policy if exists "agent_cases_update" on public.agent_cases;
drop policy if exists "agent_cases_delete" on public.agent_cases;

create policy "agent_cases_select" on public.agent_cases
  for select using (
    public.fn_is_platform_admin()
    or exists (
      select 1 from public.conversations c
      where c.id = agent_cases.conversation_id
    )
  );
create policy "agent_cases_insert" on public.agent_cases
  for insert with check (organization_id in (select public.fn_user_org_ids()));
create policy "agent_cases_update" on public.agent_cases
  for update using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
create policy "agent_cases_delete" on public.agent_cases
  for delete using (organization_id in (select public.fn_user_org_ids()));

-- agent_case_events: SELECT herda o caso (molde do cae_select da 0173).
drop policy if exists "tenant_isolation_agent_case_events_select" on public.agent_case_events;
drop policy if exists "tenant_isolation_agent_case_events_insert" on public.agent_case_events;
drop policy if exists "agent_case_events_select" on public.agent_case_events;
drop policy if exists "agent_case_events_insert" on public.agent_case_events;

create policy "agent_case_events_select" on public.agent_case_events
  for select using (
    public.fn_is_platform_admin()
    or exists (
      select 1 from public.agent_cases ac
      where ac.id = agent_case_events.case_id
    )
  );
create policy "agent_case_events_insert" on public.agent_case_events
  for insert with check (organization_id in (select public.fn_user_org_ids()));

-- crm_lead_scores / crm_lead_risk_states / crm_lead_reactivations:
-- SELECT herda o lead via fn_can_view_lead (molde crm_lead_activities_select).
drop policy if exists "tenant_isolation_crm_lead_scores_all" on public.crm_lead_scores;
drop policy if exists "crm_lead_scores_select" on public.crm_lead_scores;
drop policy if exists "crm_lead_scores_insert" on public.crm_lead_scores;
drop policy if exists "crm_lead_scores_update" on public.crm_lead_scores;
drop policy if exists "crm_lead_scores_delete" on public.crm_lead_scores;

create policy "crm_lead_scores_select" on public.crm_lead_scores
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_scores.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );
create policy "crm_lead_scores_insert" on public.crm_lead_scores
  for insert with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_scores_update" on public.crm_lead_scores
  for update using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_scores_delete" on public.crm_lead_scores
  for delete using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists "tenant_isolation_crm_lead_risk_states_all" on public.crm_lead_risk_states;
drop policy if exists "crm_lead_risk_states_select" on public.crm_lead_risk_states;
drop policy if exists "crm_lead_risk_states_insert" on public.crm_lead_risk_states;
drop policy if exists "crm_lead_risk_states_update" on public.crm_lead_risk_states;
drop policy if exists "crm_lead_risk_states_delete" on public.crm_lead_risk_states;

create policy "crm_lead_risk_states_select" on public.crm_lead_risk_states
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_risk_states.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );
create policy "crm_lead_risk_states_insert" on public.crm_lead_risk_states
  for insert with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_risk_states_update" on public.crm_lead_risk_states
  for update using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_risk_states_delete" on public.crm_lead_risk_states
  for delete using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists "tenant_isolation_crm_lead_reactivations_all" on public.crm_lead_reactivations;
drop policy if exists "crm_lead_reactivations_select" on public.crm_lead_reactivations;
drop policy if exists "crm_lead_reactivations_insert" on public.crm_lead_reactivations;
drop policy if exists "crm_lead_reactivations_update" on public.crm_lead_reactivations;
drop policy if exists "crm_lead_reactivations_delete" on public.crm_lead_reactivations;

create policy "crm_lead_reactivations_select" on public.crm_lead_reactivations
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_reactivations.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );
create policy "crm_lead_reactivations_insert" on public.crm_lead_reactivations
  for insert with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_reactivations_update" on public.crm_lead_reactivations
  for update using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
create policy "crm_lead_reactivations_delete" on public.crm_lead_reactivations
  for delete using (organization_id in (select public.fn_user_org_ids()));

-- demandas: SELECT herda o CONTATO (contact_id é NOT NULL).
drop policy if exists "tenant_isolation_demandas_all" on public.demandas;
drop policy if exists "demandas_select" on public.demandas;
drop policy if exists "demandas_insert" on public.demandas;
drop policy if exists "demandas_update" on public.demandas;
drop policy if exists "demandas_delete" on public.demandas;

create policy "demandas_select" on public.demandas
  for select using (
    public.fn_can_view_contact(organization_id, contact_id)
  );
create policy "demandas_insert" on public.demandas
  for insert with check (organization_id in (select * from public.fn_user_org_ids()));
create policy "demandas_update" on public.demandas
  for update using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));
create policy "demandas_delete" on public.demandas
  for delete using (organization_id in (select * from public.fn_user_org_ids()));

-- calendar_appointments: SELECT = viewer/manager/admin org-wide (o mesmo escopo
-- de fn_can_view_contact para esses papéis — a agenda é leitura de supervisão, o
-- gate da agenda é de ESCRITA) OU o atendente dono OU o contato visível ao agent.
-- A _write era FOR ALL (USING governa SELECT) — re-expressa por-comando.
drop policy if exists "tenant_isolation_calendar_appointments_all" on public.calendar_appointments;
drop policy if exists "calendar_appointments_select" on public.calendar_appointments;
drop policy if exists "calendar_appointments_write"  on public.calendar_appointments;
drop policy if exists "calendar_appointments_insert" on public.calendar_appointments;
drop policy if exists "calendar_appointments_update" on public.calendar_appointments;
drop policy if exists "calendar_appointments_delete" on public.calendar_appointments;

create policy "calendar_appointments_select" on public.calendar_appointments
  for select using (
    public.fn_is_platform_admin()
    or public.fn_user_role_in_org(organization_id) in ('viewer','manager','admin')
    or owner_user_id = auth.uid()
    or (contact_id is not null and public.fn_can_view_contact(organization_id, contact_id))
  );
create policy "calendar_appointments_insert" on public.calendar_appointments
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "calendar_appointments_update" on public.calendar_appointments
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "calendar_appointments_delete" on public.calendar_appointments
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- P5 — fn_conversation_assign: guard de papel + owner-sync
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_contact_id uuid;
  v_conv public.conversations%rowtype;
  v_is_manager boolean;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id, contact_id
    into v_from, v_contact_id
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  -- GUARD (0204): um usuário de SESSÃO que não é manager+ só pode mexer numa
  -- atribuição que JÁ é dele. Isso barra o corretor comum de "assumir" a
  -- conversa que a IA atende (v_from IS NULL) e de puxar a de outro atendente —
  -- pelas rotas /claim e /transfer, que é por onde a sessão dele chega aqui.
  -- 'release' (soltar a própria), 'routing' e 'handoff' (sistema) e o chamador
  -- sem auth.uid() (cron/service_role) passam. manager/admin/platform-admin
  -- passam: a intervenção manual é deles.
  v_is_manager := (auth.uid() is null) or public.fn_role_at_least(p_organization_id, 'manager');
  if not v_is_manager
     and p_reason in ('claim','transfer')
     and v_from is distinct from auth.uid() then
    raise exception 'agent_assignment_requires_manager'
      using hint = 'a common agent cannot pick up or reassign a conversation that is not already theirs; ask a manager/admin to assign it';
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  -- OWNER-SYNC (0204): atribuir a conversa passa a valer também para o(s)
  -- lead(s) aberto(s) do contato — sem isso o corretor recém-atribuído via a
  -- conversa mas não o card/timeline (com 'own', fn_can_view_lead nega). Mesma
  -- adoção que o rodízio já faz (lib/routing/worker.ts adotarLeadsDoContato); o
  -- trio owner_* fica coerente com crm_leads_owner_kind_coherence. 'routing'
  -- fica de fora: o worker do rodízio chama adotarLeadsDoContato ele mesmo.
  -- 'release' solta o lead junto com a conversa (o par não se separa).
  if v_contact_id is not null and p_reason in ('claim','transfer','release') then
    if p_to_user_id is not null then
      update public.crm_leads
         set owner_user_id  = p_to_user_id,
             owner_kind     = 'user',
             owner_agent_id = null,
             updated_at     = now()
       where organization_id = p_organization_id
         and contact_id      = v_contact_id
         and status          = 'open'
         and owner_user_id is distinct from p_to_user_id;
    else
      -- transfer/release SEM destino: solta o lead que era do liberador (nunca
      -- o de terceiros).
      update public.crm_leads
         set owner_user_id  = null,
             owner_kind     = null,
             owner_agent_id = null,
             updated_at     = now()
       where organization_id = p_organization_id
         and contact_id      = v_contact_id
         and status          = 'open'
         and owner_user_id is not distinct from v_from;
    end if;
  end if;

  return next v_conv;
end;
$$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

notify pgrst, 'reload schema';
