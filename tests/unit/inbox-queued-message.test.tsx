import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

function message(status: string): Message {
  return {
    id: "m1", organization_id: "o1", conversation_id: "c1", channel_session_id: "s1",
    contact_id: "ct1", external_id: null, type: "text", direction: "outbound", status,
    ack: null, error_code: status === "failed" ? "provider_error" : null,
    error_message: status === "failed" ? "erro" : null, body: "Resposta da IA",
    media_url: null, media_mime: null, media_size_bytes: null, media_storage_path: null,
    sent_via: "ai", sent_by_user_id: null, sent_at: "2026-09-19T16:16:00.000Z",
    delivered_at: null, read_at: null, metadata: {}, edited_at: null, revoked_at: null,
    reply_to_message_id: null, created_at: "2026-09-19T16:16:00.000Z",
  } as Message;
}

describe("Inbox diferencia intenção persistida de envio confirmado", () => {
  it("queued aparece explicitamente como aguardando envio", () => {
    render(<MessageBubble message={message("queued")} />);
    expect(screen.getByText("Aguardando envio")).toBeInTheDocument();
    expect(screen.queryByLabelText("Enviada")).toBeNull();
  });

  it("failed continua aparecendo como falha, não pendência", () => {
    render(<MessageBubble message={message("failed")} />);
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.queryByText("Aguardando envio")).toBeNull();
  });

  it("sent tem confirmação e não mostra pendência", () => {
    render(<MessageBubble message={message("sent")} />);
    expect(screen.getByLabelText("Enviada")).toBeInTheDocument();
    expect(screen.queryByText("Aguardando envio")).toBeNull();
  });
});
