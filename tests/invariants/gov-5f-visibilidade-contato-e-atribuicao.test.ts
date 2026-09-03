import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Migration 0204 — VISIBILIDADE DE CONTATO POR ATRIBUIÇÃO + trava de claim do agent.
 *
 * O `visibility_mode` (0035/0036) parava em conversations/messages/crm_leads. A
 * tabela `contacts` (telefone, e-mail, cpf_hash, birthdate) e as irmãs com PII
 * (conversation_notes, demandas, ...) seguiam org-flat, e `fn_conversation_assign`
 * — choke point de /claim /transfer /pause-ai — não tinha gate de papel: o
 * corretor comum "assumia" a conversa que a IA atendia e furava a fila.
 *
 * Este arquivo é a MATRIZ DE ACESSO do contrato de produto do piloto CTWA:
 *
 *  1. agent + IA atendendo (conversa sem dono)           → NÃO vê contato/conversa/lead
 *  2. agent + handoff sem responsável (pending, s/ dono) → NÃO vê
 *  3. manager pós-handoff                                → vê tudo E pode atribuir
 *  4. agent oficialmente atribuído                       → vê contato/conversa/lead
 *  5. outro agent                                        → NÃO vê
 *  6. Contacts / tabelas-irmãs seguem a MESMA regra
 *  7. atribuir sincroniza conversa (assigned_to_user_id) + owner do lead
 *  8. agent NÃO consegue tirar a conversa da IA (raise agent_assignment_requires_manager)
 *
 * DECISÃO registrada: o papel `viewer` permanece ORG-WIDE em fn_can_view_contact
 * (idêntico a fn_can_view_conversation/lead) — ele não reivindica conversa nem é
 * dono de lead, então escopo por atribuição o cegaria, e é read-only.
 *
 * Namespace f5f5f5f5 — exclusivo deste arquivo (cccccccc/dddddddd/eeeeeeee/
 * ffffffff já são usados por outros invariantes paralelos). Reaproveita os
 * usuários do seedGov() (GOV_AGENT_A/B, GOV_MANAGER, GOV_VIEWER) numa org NOVA
 * em visibility_mode='own'.
 */
const PILOT_ORG = "f5f5f5f5-0000-4000-8000-000000000001";
const PILOT_SESSION = "f5f5f5f5-2222-4000-8000-000000000001";
const PILOT_CONTACT = "f5f5f5f5-3333-4000-8000-000000000001";
const PILOT_CONTACT_LIVRE = "f5f5f5f5-3333-4000-8000-000000000002";
const PILOT_CONV = "f5f5f5f5-4444-4000-8000-000000000001";
const PILOT_PIPELINE = "f5f5f5f5-5555-4000-8000-000000000001";
const PILOT_STAGE = "f5f5f5f5-5555-4000-8000-000000000002";
const PILOT_LEAD = "f5f5f5f5-6666-4000-8000-000000000001";
const PILOT_NOTE = "f5f5f5f5-7777-4000-8000-000000000001";
const PILOT_DEMANDA = "f5f5f5f5-8888-4000-8000-000000000001";

/** Conta linhas visíveis de uma tabela, por id, como o usuário dado (RLS + JWT). */
function contaPorId(userId: string, tabela: string, id: string): number {
  return countAs(userId, `select count(*) from public.${tabela} where id = '${id}';`);
}

/** Quem enxerga a conversa do piloto. */
function contaConversa(userId: string): number {
  return countAs(
    userId,
    `select count(*) from public.conversations where id = '${PILOT_CONV}';`,
  );
}

/** Estado do dono da conversa, cru. */
function donoDaConversa(): string {
  return lastLine(
    sql(
      `select coalesce(assignee_kind, 'null') || '|' || coalesce(assigned_to_user_id::text, 'null')
         from public.conversations where id = '${PILOT_CONV}';`,
    ),
  );
}

/** Coloca a conversa (e o lead) no estado "a IA está atendendo": sem dono. */
function conversaNaIA(): void {
  sql(`
    update public.conversations
       set assigned_to_user_id = null, assigned_to_user_name = null, assignee_kind = 'ai',
           status = 'open', last_handoff_at = null, bot_silenced_until = null
     where id = '${PILOT_CONV}';
    update public.crm_leads
       set owner_user_id = null, owner_kind = null, owner_agent_id = null
     where id = '${PILOT_LEAD}';
  `);
}

/** Executa o assign esperando erro; devolve o stderr do psql (mensagem do raise). */
function assignRejeitado(userId: string, args: string): string {
  try {
    countAs(
      userId,
      `select count(*) from public.fn_conversation_assign(
         '${PILOT_ORG}'::uuid, '${PILOT_CONV}'::uuid, ${args})`,
    );
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? "";
  }
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${PILOT_ORG}', 'gov-pilot-0204', 'Gov Pilot 0204', 'Gov Pilot',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict (id) do update set settings = jsonb_build_object('visibility_mode', 'own');

    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values
        ('${GOV_AGENT_A}', '${PILOT_ORG}', 'agent', now()),
        ('${GOV_AGENT_B}', '${PILOT_ORG}', 'agent', now()),
        ('${GOV_MANAGER}', '${PILOT_ORG}', 'manager', now()),
        ('${GOV_VIEWER}',  '${PILOT_ORG}', 'viewer', now())
      on conflict do nothing;

    do $pilot$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${PILOT_SESSION}', '${PILOT_ORG}', 'gov-pilot-0204', '\\x00'::bytea);
    exception when unique_violation then null; end $pilot$;

    insert into public.contacts (id, organization_id, display_name)
      values
        ('${PILOT_CONTACT}',       '${PILOT_ORG}', 'Pilot Lead Contact'),
        ('${PILOT_CONTACT_LIVRE}', '${PILOT_ORG}', 'Pilot Free Contact')
      on conflict do nothing;

    -- Conversa do lead: a IA está atendendo (sem dono, assignee_kind='ai').
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assignee_kind)
      values ('${PILOT_CONV}', '${PILOT_ORG}', '${PILOT_CONTACT}', '${PILOT_SESSION}', 'open', 'ai')
      on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PILOT_PIPELINE}', '${PILOT_ORG}', 'Pilot', 'pilot')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${PILOT_STAGE}', '${PILOT_ORG}', '${PILOT_PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    -- Lead do contato, ABERTO e SEM dono (owner_kind null é o "sem dono" da 0070).
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, contact_id, status)
      values ('${PILOT_LEAD}', '${PILOT_ORG}', '${PILOT_PIPELINE}', '${PILOT_STAGE}',
              'Pilot lead', '${PILOT_CONTACT}', 'open')
      on conflict do nothing;

    -- Irmãs com PII/rastro do cliente (P3): uma nota da conversa e uma demanda.
    insert into public.conversation_notes (id, organization_id, conversation_id, body)
      values ('${PILOT_NOTE}', '${PILOT_ORG}', '${PILOT_CONV}', 'nota interna do piloto')
      on conflict do nothing;
    insert into public.demandas (id, organization_id, contact_id)
      values ('${PILOT_DEMANDA}', '${PILOT_ORG}', '${PILOT_CONTACT}')
      on conflict do nothing;
  `);
  conversaNaIA();
});

describe("0204 — matriz de acesso: agent enquanto NÃO é o responsável", () => {
  it("[1] agent + IA atendendo: NÃO vê conversa, contato nem lead", () => {
    conversaNaIA();
    expect(contaConversa(GOV_AGENT_A)).toBe(0);
    expect(contaPorId(GOV_AGENT_A, "contacts", PILOT_CONTACT)).toBe(0);
    expect(contaPorId(GOV_AGENT_A, "crm_leads", PILOT_LEAD)).toBe(0);
  });

  it("[2] agent + handoff sem responsável (pending, sem dono): continua sem ver", () => {
    sql(`update public.conversations
            set status = 'pending', assigned_to_user_id = null, assignee_kind = null,
                last_handoff_at = now(), last_handoff_reason = 'pilot_test',
                bot_silenced_until = 'infinity'
          where id = '${PILOT_CONV}';`);
    expect(contaConversa(GOV_AGENT_A)).toBe(0);
    expect(contaPorId(GOV_AGENT_A, "contacts", PILOT_CONTACT)).toBe(0);
    expect(contaPorId(GOV_AGENT_A, "crm_leads", PILOT_LEAD)).toBe(0);
  });

  it("[6a] Contacts seguem a regra: agent não lista contato não atribuído da org", () => {
    // PILOT_CONTACT_LIVRE não tem conversa nem lead — em visibility_mode='own' o
    // agent também não o vê (só o que é oficialmente dele). PILOT_CONTACT está
    // com a IA. Total visível ao agent nesta org: zero.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts where organization_id = '${PILOT_ORG}';`,
      ),
    ).toBe(0);
  });

  it("[6b] tabelas-irmãs (conversation_notes, demandas) herdam a mesma regra", () => {
    expect(contaPorId(GOV_AGENT_A, "conversation_notes", PILOT_NOTE)).toBe(0);
    expect(contaPorId(GOV_AGENT_A, "demandas", PILOT_DEMANDA)).toBe(0);
  });

  it("[8] agent NÃO consegue tirar a conversa da IA (claim) nem puxá-la (transfer)", () => {
    conversaNaIA();
    expect(
      assignRejeitado(GOV_AGENT_B, `'${GOV_AGENT_B}'::uuid, 'claim', null::uuid, true`),
    ).toContain("agent_assignment_requires_manager");
    expect(
      assignRejeitado(GOV_AGENT_A, `'${GOV_AGENT_B}'::uuid, 'transfer', null::uuid, false`),
    ).toContain("agent_assignment_requires_manager");
    // Nada mudou: a conversa continua com a IA.
    expect(donoDaConversa()).toBe("ai|null");
  });
});

describe("0204 — manager pós-handoff atribui, e a atribuição sincroniza tudo", () => {
  it("[3] manager vê a conversa/contato/lead org-wide E consegue atribuir ao corretor", () => {
    conversaNaIA();
    sql(`update public.conversations
            set status = 'pending', last_handoff_at = now(), assignee_kind = null
          where id = '${PILOT_CONV}';`);

    expect(contaConversa(GOV_MANAGER)).toBe(1);
    expect(contaPorId(GOV_MANAGER, "contacts", PILOT_CONTACT)).toBe(1);
    expect(contaPorId(GOV_MANAGER, "crm_leads", PILOT_LEAD)).toBe(1);

    const atribuido = countAs(
      GOV_MANAGER,
      `select count(*) from public.fn_conversation_assign(
         '${PILOT_ORG}'::uuid, '${PILOT_CONV}'::uuid, '${GOV_AGENT_A}'::uuid, 'transfer', null::uuid, false)`,
    );
    expect(atribuido).toBe(1);
  });

  it("[7] atribuir sincronizou conversa (assigned_to_user_id) E owner do lead", () => {
    expect(
      lastLine(sql(`select assigned_to_user_id from public.conversations where id = '${PILOT_CONV}';`)),
    ).toBe(GOV_AGENT_A);
    expect(
      lastLine(sql(
        `select coalesce(owner_user_id::text, 'null') || '|' || coalesce(owner_kind, 'null')
           from public.crm_leads where id = '${PILOT_LEAD}';`,
      )),
    ).toBe(`${GOV_AGENT_A}|user`);
  });

  it("[4] o corretor oficialmente atribuído passa a ver conversa, contato e lead", () => {
    expect(contaConversa(GOV_AGENT_A)).toBe(1);
    expect(contaPorId(GOV_AGENT_A, "contacts", PILOT_CONTACT)).toBe(1);
    expect(contaPorId(GOV_AGENT_A, "crm_leads", PILOT_LEAD)).toBe(1);
    // …e as irmãs acompanham.
    expect(contaPorId(GOV_AGENT_A, "conversation_notes", PILOT_NOTE)).toBe(1);
    expect(contaPorId(GOV_AGENT_A, "demandas", PILOT_DEMANDA)).toBe(1);
  });

  it("[5] OUTRO corretor continua sem ver nada disso", () => {
    expect(contaConversa(GOV_AGENT_B)).toBe(0);
    expect(contaPorId(GOV_AGENT_B, "contacts", PILOT_CONTACT)).toBe(0);
    expect(contaPorId(GOV_AGENT_B, "crm_leads", PILOT_LEAD)).toBe(0);
    expect(contaPorId(GOV_AGENT_B, "conversation_notes", PILOT_NOTE)).toBe(0);
    expect(contaPorId(GOV_AGENT_B, "demandas", PILOT_DEMANDA)).toBe(0);
  });

  it("DECISÃO: o papel viewer permanece ORG-WIDE para PII (contato visível sem atribuição)", () => {
    expect(contaPorId(GOV_VIEWER, "contacts", PILOT_CONTACT)).toBe(1);
    expect(contaPorId(GOV_VIEWER, "contacts", PILOT_CONTACT_LIVRE)).toBe(1);
    expect(contaPorId(GOV_VIEWER, "crm_leads", PILOT_LEAD)).toBe(1);
  });
});
