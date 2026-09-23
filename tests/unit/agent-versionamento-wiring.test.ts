import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const actions = readFileSync(join(process.cwd(), "app/app/ai/agents/[id]/_actions.ts"), "utf8");
const publish = readFileSync(join(process.cwd(), "lib/ai/agents/publish.ts"), "utf8");

describe("ações canônicas usam a regra transversal de versionamento", () => {
  it("save resolve a publicada pelo pointer e ignora draft obsoleto", () => {
    expect(actions).toContain('select("id, kind, archived_at, published_version_id")');
    expect(actions).toContain("draftVigente(");
    expect(actions).toContain("published?.version_number ?? null");
    expect(actions).toContain("proximoNumeroDeVersao(");
    expect(actions).toContain("base_version_id: published?.id ?? null");
  });

  it("wrapper compartilhado bloqueia publish regressivo antes da RPC", () => {
    const guard = publish.indexOf("publicacaoAvancaLinhaDoTempo(");
    const rpc = publish.indexOf('.rpc("fn_publish_ai_agent_version"');
    expect(guard).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(guard);
    expect(publish).toContain('code: "version_not_newer"');
  });
});
