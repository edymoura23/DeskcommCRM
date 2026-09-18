// tests/unit/agent-split-message.test.ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

describe("splitIntoBubbles", () => {
  it("texto curto vira uma bolha só (trim)", () => {
    expect(splitIntoBubbles("  Olá, tudo bem?  ", 600)).toEqual(["Olá, tudo bem?"]);
  });
  it("vazio/whitespace → []", () => {
    expect(splitIntoBubbles("", 600)).toEqual([]);
    expect(splitIntoBubbles("   \n  ", 600)).toEqual([]);
  });
  it("quebra por parágrafo quando cabe", () => {
    const out = splitIntoBubbles("Primeiro parágrafo.\n\nSegundo parágrafo.", 30);
    expect(out).toEqual(["Primeiro parágrafo.", "Segundo parágrafo."]);
  });
  it("nenhuma bolha excede maxChars (quebra por sentença)", () => {
    const text = "Oi! Como você está hoje? Queria falar do seu pedido. Ele já saiu para entrega.";
    const out = splitIntoBubbles(text, 30);
    expect(out.every((b) => b.length <= 30)).toBe(true);
    expect(out.join(" ")).toContain("pedido");
  });
  it("junta sentenças curtas adjacentes até o teto", () => {
    const out = splitIntoBubbles("Oi. Tudo bem? Beleza.", 100);
    expect(out).toHaveLength(1); // tudo cabe em 100
  });
  it("palavra única maior que o teto vai sozinha (não corta no meio)", () => {
    const big = "a".repeat(50);
    const out = splitIntoBubbles(`curto ${big} fim`, 20);
    expect(out).toContain(big);
    expect(out.every((b) => b.length > 0)).toBe(true);
  });
  it("não perde texto quando o ponto não é seguido de espaço (preço decimal)", () => {
    const out = splitIntoBubbles(
      "Seu pedido de R$149.90 já saiu para entrega hoje as 14h no bairro central.",
      30,
    );
    expect(out.join(" ")).toContain("Seu pedido");
    expect(out.join(" ")).toContain("R$149.90");
    expect(out.some((bubble) => bubble.includes("R$149.90"))).toBe(true);
    expect(out.join(" ")).toContain("central");
  });
});

describe("splitIntoBubbles — fronteiras seguras", () => {
  it.each([
    "Veja https://example.com/lotes/mapa.pdf?valor=1.25 para conhecer os detalhes. Posso esclarecer.",
    "O valor é R$ 1.234,56 e a medida é 250.5 metros. Consulte as condições.",
    "Fale com a Dra. Maria na Av. Central. Ela explica os detalhes.",
    "Olá! Tudo bem? Esta é a informação solicitada. Obrigada… Até breve.",
    "Pontuação isolada: ... ! ? também deve ser preservada no texto.",
  ])("preserva o texto e respeita o teto: %s", (text) => {
    const max = 65;
    const out = splitIntoBubbles(text, max);
    expect(out.join(" ")).toBe(text);
    expect(out.every((bubble) => bubble.length > 0 && bubble.length <= max)).toBe(true);
  });

  it("mantém URL atômica maior que o teto, sem inserir espaços", () => {
    const url = "https://example.com/documentos/arquivo-com-nome-extenso.pdf";
    const out = splitIntoBubbles("Confira " + url + " agora.", 20);
    expect(out).toContain(url);
    expect(out.join(" ")).toBe("Confira " + url + " agora.");
  });

  it("separa finais reais de frase", () => {
    expect(splitIntoBubbles("Primeira frase. Segunda frase!", 20))
      .toEqual(["Primeira frase.", "Segunda frase!"]);
  });

  it("não separa uma abreviação como se encerrasse a frase", () => {
    expect(splitIntoBubbles("Fale com a Dra. Maria. Depois retornamos.", 23))
      .toEqual(["Fale com a Dra. Maria.", "Depois retornamos."]);
  });
});

describe("splitter — dívida de atomicidade R$ + valor", () => {
  it("separação de R$ já existe na base canônica, sem perda de conteúdo neste caso", () => {
    const text = "Valor R$ 1234,56 disponível";
    const expected = ["Valor R$", "1234,56", "disponível"];
    const canonicalSource = execFileSync("git", [
      "show",
      "f41b1595e65238c1dc0b2a46ce96933a7b1c30c0:lib/agent-engine/agent/split-message.ts",
    ], { encoding: "utf8" });
    const output = ts.transpileModule(canonicalSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const sandbox = { exports: {} as { splitIntoBubbles?: typeof splitIntoBubbles } };
    runInNewContext(output.outputText, sandbox);
    expect(sandbox.exports.splitIntoBubbles!(text, 10)).toEqual(expected);
    expect(splitIntoBubbles(text, 10)).toEqual(expected);
    expect(expected.join(" ")).toBe(text);
    expect(expected.every((bubble) => bubble.length <= 10)).toBe(true);
  });

  it("número com milhares permanece íntegro mesmo com símbolo em outra bolha", () => {
    const text = "Valor R$ 1.234,56 disponível";
    const out = splitIntoBubbles(text, 10);
    expect(out).toEqual(["Valor R$", "1.234,56", "disponível"]);
    expect(out.join(" ")).toBe(text);
  });
});


describe("splitter — regressões históricas transversais preservadas", () => {
  // ── B1: splitSentences não corrompe URL / decimal BR / abreviação ──────────
  it("URL com pontos permanece íntegra e contígua numa bolha (acima do teto)", () => {
    const url = "https://maps.app.goo.gl/d5SyLzbAPmaLoGkE7";
    const text = `A localização oficial do Jardim Bela Aurora é esta: ${url} e fica a cerca de um quilômetro depois da Fiat, na avenida principal.`;
    const out = splitIntoBubbles(text, 60);
    expect(out.some((b) => b.includes(url))).toBe(true); // URL inteira, sem espaços internos
    expect(out.every((b) => b.length <= 60 || !/\s/.test(b))).toBe(true);
    expect(out.join(" ")).not.toContain("maps. app"); // não estilhaçou a URL
  });

  it("valor em real no formato BR (R$ 1.234,56) não é quebrado no ponto de milhar", () => {
    const text =
      "O lote residencial de referência sai por R$ 1.234,56 e há opções maiores acima disso conforme a quadra escolhida pelo cliente.";
    const out = splitIntoBubbles(text, 40);
    expect(out.some((b) => b.includes("R$ 1.234,56"))).toBe(true);
    expect(out.join(" ")).not.toContain("1. 234");
  });

  it("decimal com metragem (288.5 m²) não é quebrado", () => {
    const out = splitIntoBubbles(
      "A maioria dos lotes tem a partir de 288.5 m² de área e a metragem varia conforme a quadra do empreendimento em Itaperuna.",
      40,
    );
    expect(out.some((b) => b.includes("288.5"))).toBe(true);
    expect(out.join(" ")).not.toContain("288. 5");
  });

  it("abreviação comum (Sr., etc.) não gera fronteira falsa que corrompa o texto", () => {
    const out = splitIntoBubbles(
      "Combinei com o Sr. Silva de retornar amanhã de manhã sobre a proposta do lote comercial na quadra D-10.",
      30,
    );
    // rejuntado sem espúrio: "Sr. Silva" contíguo em alguma bolha
    expect(out.some((b) => b.includes("Sr. Silva"))).toBe(true);
    expect(out.join(" ")).not.toContain("Sr . Silva");
  });

  it("sentença normal ainda quebra em fronteira real de pontuação", () => {
    const out = splitIntoBubbles(
      "Oi, tudo bem? O Jardim Bela Aurora é um loteamento aberto. Quer que eu te explique a proposta?",
      40,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain("tudo bem?");
  });

  it("texto acima do teto: nenhuma bolha excede o teto (salvo palavra atômica) e nada se perde", () => {
    const original =
      "O Jardim Bela Aurora fica em Itaperuna, na avenida principal, a cerca de cinco minutos de escolas, comércios e hospitais. A referência de acesso é aproximadamente um quilômetro depois da Fiat. Se quiser, eu te mando a localização oficial: https://maps.app.goo.gl/d5SyLzbAPmaLoGkE7";
    const out = splitIntoBubbles(original, 90);
    for (const b of out) {
      // ≤ teto OU é uma unidade atômica sem espaço (ex.: URL longa)
      expect(b.length <= 90 || !/\s/.test(b)).toBe(true);
    }
    // sem perda: cada palavra do original aparece em alguma bolha
    for (const w of original.split(/\s+/)) {
      expect(out.some((b) => b.includes(w))).toBe(true);
    }
  });
});


describe("splitter — união das abreviações histórica e G4", () => {
  it.each(["Srs", "Sras", "Drs", "Pág", "nº", "Obs", "Ref", "Aprox", "Rod", "Apto", "N"])(
    "preserva a fronteira de %s. sem perder conteúdo", (abbr) => {
      const first = abbr + ". Central.";
      const text = first + " Depois retornamos.";
      expect(splitIntoBubbles(text, first.length)).toEqual([first, "Depois", "retornamos."]);
    },
  );
});
