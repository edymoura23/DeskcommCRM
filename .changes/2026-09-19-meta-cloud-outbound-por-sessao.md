---
type: fix
scope: channels
---

Meta Cloud agora usa a credencial da sessão e da organização corretas para
mensagens e templates. Saídas em espera ficam visíveis como pendentes, e o
redrive transversal exige marca de ativação para não consumir filas históricas.
