import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { publishAgentVersion } from "@/lib/ai/agents/publish";
import {
  draftVigente,
  proximoNumeroDeVersao,
  publicacaoAvancaLinhaDoTempo,
} from "@/lib/ai/agents/versionamento";

const v = (version_number: number) => ({ id: `v${version_number}`, version_number });

describe("save de draft respeita a versão publicada", () => {
  it("published=v6 + draft legado=v4 cria v7 baseado na linha da publicada", () => {
    const historico = [v(4), v(6)];
    expect(draftVigente([v(4)], 6)).toBeNull();
    expect(proximoNumeroDeVersao(historico, 6)).toBe(7);
    expect(historico.map((version) => version.id)).toEqual(["v4", "v6"]);
  });

  it("published=v6 + draft vigente=v7 reutiliza v7", () => {
    expect(draftVigente([v(4), v(7)], 6)?.id).toBe("v7");
  });

  it("draft igual à publicada também não é vigente", () => {
    expect(draftVigente([v(6)], 6)).toBeNull();
  });

  it("agente sem publicada reutiliza o draft mais novo", () => {
    expect(draftVigente([v(1), v(2)], null)?.id).toBe("v2");
  });

  it("agente sem versão começa em v1", () => {
    expect(proximoNumeroDeVersao([], null)).toBe(1);
  });
});

describe("publish só avança a linha do tempo", () => {
  it("published=v6 rejeita publicar a própria v6", () => {
    expect(publicacaoAvancaLinhaDoTempo(6, 6)).toBe(false);
  });

  it.each([5, 4])("published=v6 rejeita publicar v%s", (target) => {
    expect(publicacaoAvancaLinhaDoTempo(target, 6)).toBe(false);
  });

  it("published=v6 permite publicar v7", () => {
    expect(publicacaoAvancaLinhaDoTempo(7, 6)).toBe(true);
  });

  it("agente sem publicada permite a primeira publicação", () => {
    expect(publicacaoAvancaLinhaDoTempo(1, null)).toBe(true);
  });
});

function adminDePublicacao(target: number, published: number | null) {
  const targetId = `v${target}`;
  const publishedId = published === null ? null : `v${published}`;
  const rpc = vi.fn().mockResolvedValue({
    data: [{
      agent_id: "agent-1",
      version_id: targetId,
      previous_version_id: publishedId,
      published_at: "2026-09-23T12:00:00.000Z",
    }],
    error: null,
  });
  const admin = {
    from(table: string) {
      if (table === "ai_agents") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({
            data: { published_version_id: publishedId },
            error: null,
          }),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: async () => ({
          data: [
            { id: targetId, agent_id: "agent-1", version_number: target },
            ...(published !== null && published !== target
              ? [{ id: publishedId, agent_id: "agent-1", version_number: published }]
              : []),
          ],
          error: null,
        }),
      };
      return chain;
    },
    rpc,
  };
  return { admin: admin as unknown as SupabaseClient, rpc };
}

describe("wrapper canônico aplica o guard antes da RPC", () => {
  it.each([6, 5, 4])("published=v6 não chama RPC para v%s", async (target) => {
    const { admin, rpc } = adminDePublicacao(target, 6);
    const result = await publishAgentVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      versionId: `v${target}`,
    });
    expect(result).toMatchObject({ ok: false, code: "version_not_newer" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("published=v6 chama RPC para v7", async () => {
    const { admin, rpc } = adminDePublicacao(7, 6);
    const result = await publishAgentVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      versionId: "v7",
    });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("sem publicada mantém a primeira publicação", async () => {
    const { admin, rpc } = adminDePublicacao(1, null);
    const result = await publishAgentVersion(admin, {
      orgId: "org-1",
      agentId: "agent-1",
      versionId: "v1",
    });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
  });
});
