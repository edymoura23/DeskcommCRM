---
impacto: capacidade_nova
secao: corrigido
titulo: Webhook de captação agora reconhece o formato de lead do RD Station
---

Ao apontar um webhook do RD Station para uma fonte de captação de leads, os
envios reais não viravam lead: o RD Station empacota os dados dentro de uma
lista (`leads: [...]`), e o leitor de campos do webhook só olhava o nível de
cima, então nome, e-mail e telefone chegavam "em branco" e a captação era
recusada. O botão interno "Enviar lead de teste" funcionava porque manda os
campos soltos — o que escondia o problema.

Agora o webhook reconhece esse formato: extrai o nome, o e-mail e o telefone
(inclusive quando o telefone vem no campo de celular do RD, e não no campo de
telefone comercial, que costuma vir vazio) e cria o lead na fonte/funil/etapa
configurados. Reenvio do mesmo evento pelo RD Station não gera lead duplicado.

Os formatos que já funcionavam (campos soltos, Respondi) continuam iguais. Você
não precisa fazer nada para adotar — a partir desta versão os leads do RD
Station passam a entrar sozinhos.
