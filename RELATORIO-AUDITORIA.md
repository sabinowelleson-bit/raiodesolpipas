# Relatório de Auditoria — Raio de Sol Pipas

**Data:** 2026-06-20
**Branch:** `auditoria/varredura`
**Escopo:** varredura completa do repositório (HTML/CSS/JS estático + funções `/api` + integração Supabase/InfinitePay).
**Validação:** `node --check` em todo JS, parser nos `<script>` inline, e suíte de 21 testes anti-fraude rodando contra o handler real de `/api/criar-pagamento` (todos passam).

---

## ⚠️ 0. DECISÕES HUMANAS — STATUS

| # | Tema | Situação | Status |
|---|------|----------|--------|
| H1 | **"12x sem juros" + "5% off no Pix"** | O servidor cobra o valor cheio. Decisão do dono: **remover os textos**. | ✅ **RESOLVIDO** — removidas as frases "12x sem juros"/"5% off no Pix" e o badge "12x" de `produto.html`, `carrinho_raio_de_sol.html` e `app.js`, sem deixar elemento vazio. Mantidos badge PIX (método real) e aviso de confirmação rápida do Pix. |
| H2 | **Remover INSERT anônimo em `pedidos` (RLS)** | — | ✅ **FEITO pelo dono** direto no Supabase: dropadas as policies de INSERT anônimo (`site cria pedido`, `pedidos_insert_anon`) + `reload schema`. |
| H3 | **Exposição de cupons** | `carrinho_raio_de_sol.html` lê `cupons` com a **anon key** para o preview de desconto → vaza códigos. O servidor já revalida, então **não é fraude de preço**. | ⏳ **PENDENTE (por opção do dono)** — não fechar cupons hoje. Fechar o RLS de `cupons` exige antes um `/api/validar-cupom` (não construído nesta rodada). |
| H4 | **CSP (Content-Security-Policy)** | Não adicionado. O site tem MUITO script/estilo inline; um CSP errado quebra tudo. | ⏳ **PENDENTE** — propor policy e testar num **preview** da Vercel antes de produção. |
| H5 | **Redirect apex → www** | Canônico é `www`. Configurar no **painel da Vercel** (não por host no `vercel.json`, risco de loop). | ⏳ **PENDENTE** — confirmar no painel. |

---

## 1. Resumo executivo

O projeto está, no geral, **bem construído em segurança de preço**: o servidor (`/api/criar-pagamento`) recalcula tudo a partir do banco e o webhook confirma o pagamento de volta na InfinitePay antes de marcar como pago. O escape XSS (`esc()`) já era usado na maioria dos pontos.

Os achados mais sérios desta passada e o que foi feito:

- 🔴 **XSS refletido** via `?cat=` no catálogo → **corrigido**.
- 🔴 **Overselling**: o servidor não checava estoque → **RESOLVIDO de ponta a ponta**: a criação do pedido rejeita oversell e a função `baixar_estoque()` (no banco) decrementa o estoque na confirmação do pagamento, chamada pelo webhook só na transição `aguardando→pago` (1 linha = sem baixa dupla).
- 🟠 **Integridade de variante** (variante de outro produto / inativa) não validada → **corrigido**.
- 🟠 **Sem `.gitignore`** (risco de vazar `.env`) → **corrigido**.
- 🟠 **Cupons expostos à anon key** → diagnosticado; correção depende de decisão H3.
- 🟡 Vários ajustes de qualidade/SEO/a11y → **corrigidos**.

**Nenhum segredo vazado:** a única chave no código é a **anon key** (pública por design). Não há `service_role`, senha ou token secreto versionado. Confirmado por varredura completa.

---

## 2. Inventário (Passada 1)

| Arquivo | Linhas | Papel | Observação |
|---------|-------:|-------|------------|
| `index.html` | 2035 | Home | Renderiza via `app.js`. `<h1>` e JSON-LD Organization OK. |
| `admin_raio_de_sol.html` | 2076 | Painel admin | Auth Supabase + CRUD + pedidos/cupons. |
| `carrinho_raio_de_sol.html` | 1231 | Carrinho + checkout | Chama `/api/criar-pagamento`. `noindex` OK. |
| `produto.html` | 780 | PDP | Carrinho inline + busca Supabase. |
| `catalogo.html` | 764 | Catálogo | Render inline + filtro `?cat=`. |
| `app.js` | 378 | Compartilhado | Render home/admin + lógica admin. |
| `api/criar-pagamento.js` | ~250 | Serverless | Preço no servidor. **Endurecido nesta auditoria.** |
| `api/webhook.js` | 107 | Serverless | Confirma pagamento. |
| `~~api/carrinho.js~~` | 173 | — | **Removido**: órfão, código de cliente dentro de `/api`, duplicado inline. |
| `vercel.json` | — | Headers | Bons (ver §5). Sem CSP (H4). |
| `robots.txt` / `sitemap.xml` | — | SEO | **Corrigidos** p/ domínio `www`. |

**Código duplicado:** a lógica de carrinho (módulo `Carrinho`) está copiada inline em `produto.html` e `carrinho_raio_de_sol.html`. Recomenda-se consolidar num único `carrinho.js` (na raiz) incluído por `<script>` em todas as páginas — **não fiz** porque é refatoração que toca telas em produção; ver §7 Recomendações.

---

## 3. Achados e correções

### 🔴 Críticos

**C1 — XSS refletido no catálogo** · `catalogo.html:622`
O parâmetro `?cat=` ia para `innerHTML` sem escape na mensagem "Nenhum produto em <cat>". Payload `?cat=<img src=x onerror=alert(1)>` executava.
**Correção:** envolvido em `esc(nomeCat)`. ✅ Validado (parser OK; `esc()` existe no arquivo).

**C2 — Overselling (estoque não verificado no servidor)** · `api/criar-pagamento.js` + `api/webhook.js` + função no banco — ✅ **RESOLVIDO**
O servidor montava o pedido sem checar estoque → era possível comprar mais que o disponível.
**Correção 1 (criação do pedido):** rejeita `estoque=0` (esgotado) e `qtd > estoque` (HTTP 409). `estoque=null` = não gerenciado (sem teto). ✅ Validado por testes 2c e 3.
**Correção 2 (baixa na confirmação):** função `baixar_estoque(p_pedido_id uuid)` criada no banco de produção (`security definer`, `grant execute` só p/ `service_role`) — decrementa `variantes.estoque` lendo `pedidos.itens` (jsonb) com `update ... where estoque >= q` (trata corrida) e guarda contra `qtd<=0`. O `webhook.js` chama a RPC **apenas** quando o PATCH `aguardando→pago` afeta 1 linha (`return=representation&select=id`), evitando baixa dupla em webhook duplicado; falha na baixa é logada sem derrubar o webhook. SQL em `sql/02_baixar_estoque.sql`.
**A testar em produção:** baixa após pagamento real, idempotência (reenvio do webhook não baixa de novo) e corrida (dois pedidos do último item).

### 🟠 Altos

**A1 — Integridade da variante** · `api/criar-pagamento.js`
Não se validava se a `variante_id` pertencia ao `produto_id` enviado, nem se a variante estava `ativo=true`.
**Correção:** rejeita variante de outro produto, variante `ativo=false` e produto `ativo=false` (HTTP 400). ✅ Testes 4a/4b/4d.

**A2 — Quantidade abusiva** · `api/criar-pagamento.js`
`qtd` fracionária/negativa não era normalizada para inteiro.
**Correção:** `Math.max(1, Math.floor(Number(qtd)||1))` + teto pelo estoque. ✅ Testes 2a/2b.

**A3 — Sem `.gitignore`** · raiz
Risco de commitar `.env.local` com `SUPABASE_SERVICE_ROLE_KEY`.
**Correção:** `.gitignore` ignora `.env*` (exceto `.env.example`), `node_modules`, `.vercel`, logs. ✅

**A4 — Abuso cross-origin / sem checagem de origem** · `api/criar-pagamento.js`
Aceitava POST de qualquer origem.
**Correção:** allowlist de `Origin` (bloqueia browser de outra origem; mantém same-origin e server-to-server). ✅ Testes 9a/9b.
*Rate limiting* continua **não** implementado (precisa de store externo, ex.: Upstash/Vercel KV) — ver §7.

**A5 — Cupons expostos à anon key** · `carrinho_raio_de_sol.html:1064` → ver **H3**. (Não é fraude de preço; o servidor revalida.)

### 🟡 Médios

**M1 — `ref` do pedido podia colidir** · `api/criar-pagamento.js:151`
`RS-<Date.now()>` colide em ms simultâneos (double-click).
**Correção:** sufixo aleatório `RS-<ts>-<rand>`. ✅

**M2 — Imagem sem escape no `src`** · `produto.html:535`, `app.js` (2 cards)
`imagem_url` (controlada pelo admin) ia ao atributo `src` sem escape — um `"` quebraria o atributo.
**Correção:** `esc(foto)` nos `src`. ✅ (defesa em profundidade)

**M3 — Dependência externa frágil** · `carrinho_raio_de_sol.html:899`
Placeholder usava `via.placeholder.com` (3rd-party que pode sair do ar).
**Correção:** trocado por SVG data-URI local. ✅

**M4 — Falta Product JSON-LD na PDP** · `produto.html`
**Correção:** injeta `schema.org/Product` (preço a partir das variantes ativas, `InStock/OutOfStock`) após o produto carregar. ✅ (parser OK)

**M5 — Bug de UI de estoque na PDP** · `produto.html` (controle de quantidade)
Quando esgotado, o input de qtd recebia `max=0` mas valor `1`. O botão "Adicionar" já fica desabilitado (`estoque<=0`), então não há risco de compra; é só inconsistência visual. **Anotado** — correção opcional (não alterei para não mexer em lógica que já bloqueia a compra corretamente).

### 🟢 Baixos

**B1 — `robots.txt`/`sitemap.xml` com domínio apex** → **corrigido** p/ `www`; robots agora bloqueia `carrinho` e `pagamento-concluido`. ✅
**B2 — a11y: controle de quantidade sem rótulo** · `produto.html` → `<label for>` + `aria-label` nos botões. ✅
**B3 — `api/carrinho.js` órfão em `/api`** → removido (dead code; viraria função serverless quebrada). ✅
**B4 — Filtro de categoria sensível a maiúsculas** · `catalogo.html:605` (`p.categoria === cat`). Pode falhar se a URL vier com caixa diferente do banco. **Anotado** (não alterei: pode ser intencional, e mudar afeta os chips de navegação). Recomendação: comparar com `.toLowerCase()` dos dois lados.

---

## 4. O que foi VALIDADO e como

- **`node --check`** em `api/criar-pagamento.js`, `api/webhook.js`, `app.js` → OK.
- **Parser** (`new Function`) em todos os `<script>` inline de `produto.html`, `catalogo.html`, `carrinho_raio_de_sol.html` → 0 erros.
- **Suíte anti-fraude** `tests/criar-pagamento.test.mjs` (mocka Supabase + InfinitePay, dirige o handler real): **21/21 passam** — preço forjado ignorado, qtd negativa/fracionária/gigante, estoque esgotado, variante de outro produto, variante/produto inativos, cupom expirado/inexistente/case-insensitive, cupom que zera o total (rejeitado), frete inválido, carrinho vazio, id não numérico, cliente incompleto, produto inexistente, origem não autorizada.
  Rodar: `node tests/criar-pagamento.test.mjs`

**Não foi possível validar localmente** o fluxo ponta-a-ponta com `vercel dev` (exige `SUPABASE_SERVICE_ROLE_KEY` real e o projeto Supabase de produção, aos quais não tenho acesso). A suíte com mocks cobre a lógica do servidor de forma determinística.

---

## 5. Headers / `vercel.json`

Presentes e corretos: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (anti-clickjacking), `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security` (HSTS, 1 ano + subdomínios), `Permissions-Policy` restritiva. **Falta apenas CSP** → decisão **H4** (testar em preview).

---

## 6. Supabase — status (executado com o dono, passo a passo)

> O Supabase conectado a esta sessão só expõe o projeto `mmqfqlbojsbuuodfbilh` (inativo), **não** o de produção `kscqoczfdtoanjdoidtl`. Eu gerei os SQL e o dono rodou no SQL Editor de produção.

1. ✅ **`sql/03_verificacoes.sql`** (verificação) — **rodado pelo dono**. Confirmado: `variantes.id` uuid e `variantes.estoque` integer NOT NULL (estoque mora na variante); `pedidos.itens` jsonb; `produtos.id` bigint. Schema saudável, buckets/colunas OK.
2. ✅ **`sql/02_baixar_estoque.sql`** (baixa de estoque) — função `baixar_estoque(uuid)` **criada em produção** (com `grant execute` p/ `service_role`) e o webhook já chama a RPC. Ver **C2** (resolvido).
3. ✅ **RLS — INSERT anônimo em `pedidos`** — **dropado pelo dono** (policies `site cria pedido` e `pedidos_insert_anon`) + `reload schema`. (Não foi aplicado o `sql/01` inteiro: por decisão do dono, `produtos`/`variantes`/`cupons` ficaram como estavam — catálogo segue funcionando.)
4. ⏳ **`cupons` (RLS) e `/api/validar-cupom`** — **adiados** por opção do dono (ver **H3**). `sql/01_rls_policies.sql` segue disponível para quando decidirem fechar cupons.

---

## 7. Recomendações (não aplicadas — fora do escopo seguro desta passada)

- **Consolidar o carrinho** num único `carrinho.js` na raiz, incluído por `<script>` em `produto.html` e `carrinho_raio_de_sol.html`, removendo as cópias inline (hoje há 2 cópias idênticas). Reduz risco de divergência. Refatoração que toca telas em produção → fazer com teste manual de cada fluxo.
- **Rate limiting** em `/api/criar-pagamento` (ex.: Vercel KV / Upstash) contra spam de pedidos.
- **Endpoint `/api/validar-cupom`** para mover 100% a validação de cupom ao servidor e então fechar o RLS de `cupons` (resolve H3).
- **Idempotência** de pedido: hoje o pedido é gravado antes do link da InfinitePay (se a InfinitePay falha, sobra pedido "aguardando"); e o `ref` não é enviado pelo cliente. Avaliar enviar um `ref` do cliente como chave de deduplicação.
- **Unificar semântica de estoque** entre todas as cópias do carrinho (servidor já trata `0 = esgotado`; as cópias inline tratam `0 = sem limite` para o teto de quantidade — inconsistência de cliente, sem impacto no preço pois o servidor manda).

---

## 8. Commits desta branch (mais recente em cima)

```
fix(webhook): baixa estoque ao confirmar pagamento (1x por pedido)
docs(sql): finaliza baixar_estoque() p/ tipos de produção
fix(front): remove textos promocionais que o servidor não cumpre (H1)
docs(auditoria): relatório + SQL de RLS/estoque/verificações
fix(carrinho): troca placeholder via.placeholder.com por SVG local
fix(front): XSS refletido, JSON-LD Product, a11y e SEO
fix(pagamento): blinda criar-pagamento contra fraude e overselling
chore(seguranca): adiciona .gitignore (.env*) e remove api/carrinho.js órfão
```

Nenhuma mudança foi mesclada em `main`. Pendências remanescentes: **H3** (cupons), **H4** (CSP), **H5** (apex→www).
