---
impacto: exige_acao
secao: alterado
titulo: Corretor comum agora só vê o contato (telefone, e-mail, dados) e a conversa que lhe foram atribuídos
---

Até agora, quem tem o papel "atendente" (agent) enxergava **todos os contatos da
organização** — nome, telefone, e-mail, CPF, data de nascimento — pela tela de
Contatos, pela busca e pelo Radar de risco, mesmo quando o modo de visibilidade
estava em "só os meus". O modo de visibilidade só protegia as conversas, as
mensagens e o card do lead; a lista de contatos e as telas irmãs (notas da
conversa, casos, demandas, agenda, score e risco do lead) ficavam abertas para
qualquer membro.

A partir desta versão o modo de visibilidade vale também para essas telas:

- **"todos"** — nada muda, o atendente vê tudo.
- **"meus e não atribuídos"** (padrão) — o atendente vê os contatos sem dono e os
  seus; um contato que já está com outro atendente some da lista dele.
- **"somente meus"** — o atendente só vê o contato depois que a conversa (ou o
  lead) daquele contato é oficialmente atribuída a ele.

Gerentes, administradores e o administrador da plataforma continuam vendo tudo da
organização.

Junto vem uma trava na atribuição de conversas: um atendente comum **não
consegue mais "assumir" pela fila** uma conversa que ainda não é dele — nem uma
que a IA está atendendo, nem a de um colega. Quem distribui é gerente ou
administrador (ou o rodízio automático, se ligado). Ao atribuir uma conversa a um
atendente, o lead aberto daquele contato passa a ter esse atendente como dono, e
ele volta a enxergar o card e o histórico.

## Requer atenção

Se a sua operação depende de os atendentes **pegarem conversas sozinhos de uma
fila aberta**, escolha uma destas opções antes de atualizar:

1. Deixe o modo de visibilidade em **"todos"** ou **"meus e não atribuídos"** (o
   padrão) — nesses modos o atendente continua vendo e podendo assumir as
   conversas sem dono.
2. Ou ligue o **rodízio automático** em Configurações › Atendimento
   (`routing.mode = round_robin`) para o sistema distribuir as conversas novas.
3. Ou faça a **atribuição manual** por um gerente/administrador na tela da
   conversa.

Com o modo **"somente meus"** e o rodízio **manual**, uma conversa só chega ao
atendente por atribuição de um gerente/administrador — não há mais fila de
autoatendimento para o papel "atendente".
