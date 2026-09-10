---
impacto: capacidade_nova
secao: corrigido
titulo: Reconversão do mesmo contato não gera mais card duplicado nem repete a primeira abordagem
---

Quando o mesmo contato convertia de novo no mesmo funil (por exemplo, preenchia
outra vez o formulário do RD Station para o mesmo empreendimento), o sistema
criava um segundo card idêntico na coluna de entrada e disparava outra vez a
mensagem de primeira abordagem — a pessoa recebia a saudação inicial mais de
uma vez, e o time via dois cards para atender o mesmo interesse.

Agora, se já existe um card **aberto** desse contato naquele funil, a nova
conversão não cria card: ela entra como uma atividade ("Nova conversão
registrada") no card que já existe, e a primeira abordagem não é reenviada. O
reenvio automático do próprio RD Station (a mesma conversão entregue duas vezes)
continua sendo ignorado como antes. Se o card anterior daquele contato já tinha
sido **ganho** ou **perdido**, a nova conversão cria sim um card novo e aborda
de novo — é oportunidade nova —, e o card antigo recebe uma linha registrando
que a pessoa voltou a se interessar.

Junto com isso, quando uma conversão traz um nome melhor para um contato cujo
nome estava obviamente ruim (só números, vazio), ou um e-mail para um contato
sem e-mail, o dado é atualizado automaticamente — de forma conservadora: nome e
e-mail já válidos nunca são sobrescritos, e o telefone nunca é alterado. Cada
atualização fica registrada na linha do tempo do lead, com o valor anterior e o
novo.

Os formatos que já funcionavam (campos soltos, Respondi) continuam iguais, e
fontes/empreendimentos que não mandam identificador de conversão seguem com o
comportamento atual. Você não precisa fazer nada para adotar.
