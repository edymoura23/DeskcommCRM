---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up de silêncio deixa de reiniciar sozinho para um contato que parou de responder
---

O follow-up com gatilho de "silêncio" (aquele que aciona quando o cliente fica
um tempo sem responder) reiniciava a própria sequência indefinidamente quando o
cliente simplesmente parava de responder: cada sequência que se esgotava sem
resposta gerava a próxima, porque "está em silêncio desde X" continuava
verdadeiro — as mensagens do próprio assistente não contam como resposta do
cliente. O resultado eram novas mensagens automáticas a cada meio dia para quem
já tinha ido embora.

A partir desta versão, um contato que já teve uma sequência desse fluxo
encerrada só volta a ser inscrito se ele mesmo enviar uma mensagem nova depois
daquele encerramento — ou seja, um novo episódio de silêncio, e não a
persistência do antigo. A primeira inscrição continua igual, e um cliente que
volta a falar e some de novo continua sendo recuperado normalmente.

Vale só para o gatilho de silêncio. Os gatilhos por mudança de etapa e por
abertura de caso já dependem de um evento novo a cada vez e não têm esse
comportamento. Você não precisa fazer nada para atualizar; as sequências que já
estavam em andamento terminam naturalmente e não se repetem.
