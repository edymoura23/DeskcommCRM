---
impacto: capacidade_nova
secao: adicionado
titulo: /api/v1/health agora avisa quando o relógio do follow-up parou
---

O ciclo de atendimento que depende de passagem de tempo — follow-up por
silêncio, retomada pós-handoff, roteamento — depende de alguma coisa batendo
esse relógio a cada minuto. Antes, se esse relógio parasse, nada acusava: sem
erro, sem log, sem tela. `/api/v1/health` agora traz um campo
`followup_clock` que reporta `degraded`/`down` quando a última batida está
velha demais.

Isto funciona tanto em instalações com o container `scheduler` (self-host)
quanto no Vercel Hobby, onde o relógio é batido por um cron externo chamando
`/api/v1/system/relogio/tick` — os dois motores agora gravam o mesmo
batimento, e o `/api/v1/health` não presume qual dos dois está de pé na sua
instalação. Você não precisa fazer nada para atualizar.
