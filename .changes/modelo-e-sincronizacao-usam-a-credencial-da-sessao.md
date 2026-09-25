---
impacto: nada_mudou
secao: corrigido
titulo: Sincronizar modelos e enviar modelo usam a credencial salva na tela do canal
---
O envio de texto do canal oficial já resolvia a credencial da conexão (sessão primeiro, ambiente como reserva). O caminho do MODELO não: tanto o POST de `/api/v1/channels/templates` quanto o envio de modelo liam `META_SYSTEM_USER_TOKEN` e `META_PHONE_NUMBER_ID` do `.env`. Numa instalação que conectou o número pela tela, "Sincronizar modelos" respondia **400 `missing_meta_token`** para quem tinha a credencial salva e visível na própria tela, e o segundo número oficial da instalação não sincronizava nem enviava um modelo — logo o modelo, que é o que a janela fechada exige.

Agora os dois caminhos resolvem pela sessão, com o ambiente só como reserva, pela mesma porta que o resto do canal usa. A ordem dos desfechos não muda: sem canal oficial a resposta continua `no_meta_channel`, e sem credencial nenhuma (nem na sessão, nem no ambiente) continua `missing_meta_token` e o envio segue o desfecho de "canal não conectado" (`meta_not_configured`, recuperável) em vez de virar falha.

Nada muda para quem só tem o ambiente: a instalação continua sincronizando e enviando pelo `.env` como antes.
