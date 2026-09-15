---
impacto: nada_mudou
secao: corrigido
titulo: Resposta automática a uma mensagem do cliente deixa de esperar o horário comercial
---

Quando um cliente escrevia fora da janela de 7h às 22h (por exemplo, 1h30 da
madrugada), a resposta automática a ELE — não um follow-up proativo, uma
resposta direta à mensagem que acabou de chegar — ficava presa até a janela
abrir. O cliente só recebia retorno de manhã, sem passar pela IA nem pelo
RAG, mesmo tendo escrito na hora.

A partir desta versão, a resposta a uma mensagem recebida do cliente sai a
qualquer hora, todos os dias da semana. A janela de horário continua valendo
exatamente como antes para o que é iniciativa do sistema — follow-up
agendado e mensagens proativas —, e o warm-up, o limite diário de envios e o
intervalo mínimo entre mensagens não mudam para nenhum dos dois casos. Você
não precisa fazer nada para atualizar.
