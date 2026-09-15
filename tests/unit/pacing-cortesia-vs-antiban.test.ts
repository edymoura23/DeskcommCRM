/**
 * Invariante 3 de `docs/doctrine/restricao-de-canal.md` — "cortesia não é anti-ban".
 *
 * Horário comercial / domingo / fuso existem para NÃO INCOMODAR o cliente: valem em todo
 * canal. Throttle, jitter, warm-up e cap diário existem para NÃO SER BANIDO: só armam onde
 * há risco de ban. Desarmar o segundo grupo não pode levar o primeiro junto — senão a IA
 * passa a acordar cliente às 3h da manhã quando a API oficial entrar.
 */
import { describe, expect, it } from 'vitest';
import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';

const MADRUGADA = new Date('2026-07-28T06:00:00Z'); // 03h BRT — fora da janela 7h-22h
const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT — terça, dentro da janela
const DOMINGO_MADRUGADA = new Date('2026-07-26T06:00:00Z'); // domingo, 03h BRT — fora da janela E domingo

function input(over: { now: Date; banRisk?: boolean; sentToday?: number }) {
  return {
    now: over.now,
    knobs: PACING_DEFAULTS,
    banRisk: over.banRisk,
    state: {
      lastSentAt: null,
      sentToday: over.sentToday ?? 0,
      numberActivatedAt: null, // idade 0 = degrau mais conservador (cap 20)
    },
    crmDailyLimit: null,
    rng: () => 0,
  };
}

describe('cortesia não é anti-ban', () => {
  it('sem risco de ban, o horário comercial CONTINUA armado', () => {
    const d = decidePacing(input({ now: MADRUGADA, banRisk: false }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável'); // estreita o tipo p/ ler .code
    expect(d.code).toBe('outside_window');
  });

  it('sem risco de ban, o cap de warm-up DESARMA', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: false, sentToday: 999 }));
    expect(d.allow).toBe(true);
  });

  it('COM risco de ban, o cap de warm-up continua vetando (comportamento atual)', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: true, sentToday: 999 }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('omitir banRisk preserva o comportamento atual (default = true)', () => {
    const d = decidePacing(input({ now: COMERCIAL, sentToday: 999 }));
    expect(d.allow).toBe(false); // nenhum chamador existente muda de resultado
  });
});

/**
 * `reactiveInbound` — resposta REATIVA a um inbound do cliente (inbound_turn /
 * case_reply_turn) funciona 24/7: pula APENAS a janela de horário e o domingo.
 * Warm-up, cap diário e throttle+jitter continuam valendo — a diferença entre
 * "não incomodar quem não pediu" (cortesia, pulável na resposta) e "não ser
 * banido" (anti-ban, sempre).
 *
 * Contexto: bug estrutural medido no E2E do JBA (2026-09-08) — cliente escrevia
 * 01h30 BRT e só recebia resposta às 07h.
 */
describe('reactiveInbound pula SÓ janela + domingo', () => {
  it('reativo fora da janela (03h BRT): ALLOW — a resposta ao cliente sai agora', () => {
    const d = decidePacing({ ...input({ now: MADRUGADA }), reactiveInbound: true });
    expect(d.allow).toBe(true);
  });

  it('reativo no DOMINGO de madrugada: ALLOW — domingo também é cortesia', () => {
    const d = decidePacing({ ...input({ now: DOMINGO_MADRUGADA }), reactiveInbound: true });
    expect(d.allow).toBe(true);
  });

  it('reativo NÃO desarma warm-up: número novo (idade 0) fora da janela ainda veta por cap', () => {
    const d = decidePacing({ ...input({ now: MADRUGADA, sentToday: 999 }), reactiveInbound: true });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('reativo NÃO desarma throttle: lastSentAt recente vira waitMs (espera, não veto)', () => {
    const now = MADRUGADA;
    const d = decidePacing({
      now,
      knobs: PACING_DEFAULTS,
      crmDailyLimit: null,
      rng: () => 0,
      reactiveInbound: true,
      state: {
        lastSentAt: new Date(now.getTime() - 100), // 100ms atrás, throttle é 1200ms
        sentToday: 0,
        numberActivatedAt: new Date('2020-01-01T00:00:00Z'), // número formado: sem cap de warm-up
      },
    });
    expect(d.allow).toBe(true);
    if (!d.allow) throw new Error('inalcançável');
    expect(d.waitMs).toBeGreaterThan(0);
  });

  it('reativo COM cap diário do CRM estourado: continua vetando (daily_cap)', () => {
    const d = decidePacing({
      now: MADRUGADA,
      knobs: PACING_DEFAULTS,
      crmDailyLimit: 50,
      rng: () => 0,
      reactiveInbound: true,
      state: { lastSentAt: null, sentToday: 50, numberActivatedAt: new Date('2020-01-01T00:00:00Z') },
    });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('daily_cap');
  });

  it('omitir reactiveInbound preserva o comportamento atual: fora da janela = outside_window', () => {
    const d = decidePacing(input({ now: MADRUGADA }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('outside_window');
  });

  it('reactiveInbound=true DENTRO da janela não muda nada: ALLOW normal', () => {
    const d = decidePacing({ ...input({ now: COMERCIAL }), reactiveInbound: true });
    expect(d.allow).toBe(true);
  });
});
