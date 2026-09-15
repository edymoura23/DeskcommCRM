/**
 * `turnoAdiaPorJanela` — SÓ o turno PROATIVO (follow-up / reengajamento) é
 * adiado quando fora da janela de horário. A resposta REATIVA a um inbound do
 * cliente (`inbound_turn`, `case_reply_turn`) NUNCA é adiada — ela funciona 24/7.
 *
 * Contexto (bug estrutural medido no E2E do JBA, 2026-09-08): a guarda de janela
 * em `executarTurnoDoAgente` usava `turnoVaiFalarComOLead` e adiava o turno
 * reativo inteiro; um cliente que escrevia 01h30 BRT só era respondido às 07h.
 * A guarda passou a usar `turnoAdiaPorJanela`, que só devolve `true` para
 * `followup_turn` com envio.
 */
import { describe, expect, it } from 'vitest';

import { turnoAdiaPorJanela } from '@/lib/agent-engine/agent/inbound-turn';

function job(kind: string, purpose?: string) {
  return {
    kind,
    payload: purpose === undefined ? {} : { purpose },
  } as never;
}

describe('turnoAdiaPorJanela — só o proativo é adiado pela janela de horário', () => {
  it('inbound_turn NÃO é adiado (resposta reativa 24/7)', () => {
    expect(turnoAdiaPorJanela(job('inbound_turn'))).toBe(false);
  });

  it('case_reply_turn NÃO é adiado (também reativo — humano respondeu num caso, a IA repassa)', () => {
    expect(turnoAdiaPorJanela(job('case_reply_turn'))).toBe(false);
  });

  it('followup_turn com envio É adiado (proativo)', () => {
    expect(turnoAdiaPorJanela(job('followup_turn', 'send_message'))).toBe(true);
    expect(turnoAdiaPorJanela(job('followup_turn'))).toBe(true); // purpose omitido = envio
  });

  it('followup_turn de classificação / planejamento NÃO é adiado (não fala com o lead)', () => {
    expect(turnoAdiaPorJanela(job('followup_turn', 'classify'))).toBe(false);
    expect(turnoAdiaPorJanela(job('followup_turn', 'plan_timing'))).toBe(false);
  });

  it('operator_turn NÃO é adiado (retaguarda, nunca fala com o lead)', () => {
    expect(turnoAdiaPorJanela(job('operator_turn'))).toBe(false);
  });
});
