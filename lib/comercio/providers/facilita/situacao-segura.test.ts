import { describe, expect, it } from "vitest";

import { situacaoSegura } from "./situacao-segura";
import type { SituacaoSegura } from "../../tipos";

describe("situacaoSegura", () => {
  // Os 7 estados nativos desta instância, comprovados por GET real (2026-09).
  const casos: Array<[string, SituacaoSegura]> = [
    ["available", "disponivel"],
    ["pre-reserve", "disponivel"],
    ["reserved", "indisponivel_no_momento"],
    ["reserved-permanetly", "indisponivel_no_momento"],
    ["sale", "indisponivel_no_momento"],
    ["unavailable", "indisponivel_no_momento"],
    ["under_review_rescission", "indisponivel_no_momento"],
  ];

  for (const [bruta, esperado] of casos) {
    it(`mapeia "${bruta}" para "${esperado}"`, () => {
      expect(situacaoSegura(bruta)).toBe(esperado);
    });
  }

  it("estado desconhecido/novo falha de forma conservadora (fail-closed), nunca 'disponivel' por omissão", () => {
    expect(situacaoSegura("estado_que_o_facilita_ainda_nao_inventou")).toBe("indisponivel_no_momento");
    expect(situacaoSegura("")).toBe("indisponivel_no_momento");
  });
});
