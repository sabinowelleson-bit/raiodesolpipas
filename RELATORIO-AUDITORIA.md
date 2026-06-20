# Relatório de Auditoria — Raio de Sol Pipas

**Data:** 2026-06-20
**Branch:** `auditoria/varredura`
**Escopo:** varredura completa do repositório (HTML/CSS/JS estático + funções `/api` + integração Supabase/InfinitePay).
**Validação:** `node --check` em todo JS, parser nos `<script>` inline, e suíte de 21 testes anti-fraude rodando contra o handler real de `/api/criar-pagamento` (todos passam).

---

## ⚠️ 0. DECISÕES HUMANAS PENDENTES (o dono precisa decidir — eu NÃO decidi nenhuma)

| # | Tema | Situação | O que decidir |
|---|------|----------|----------------|
| H1 | **"12x sem juros" + "5% off no Pix"** | `carrinho_raio_de_sol.html:984-985` mostram ao cliente "12x R$x sem juros" e "5% off no Pix", mas o servidor cobra o **valor cheio** (sem desconto Pix; parcelamento é só `total/12` visual). | Aplicar de verdade no servidor (5% no Pix + parcelas reais conforme termos da InfinitePay) **ou** ajustar/remover os textos. Depende dos termos reais da InfinitePay. **Não toquei.** |
| H2 | **Remover INSERT anônimo em `pedidos` (RLS)** | SQL pronto em `sql/01_rls_policies.sql`. | Só aplicar **depois** de confirmar que `/api/criar-pagamento` está deployado e gravando (senão o checkout para de gravar). |
| H3 | **Exposição de cupons** | `carrinho_raio_de_sol.html:1064` lê a tabela `cupons` com a **anon key** (`select('*')`) para mostrar o desconto na hora → dá pra listar todos os cupons. O servidor já revalida, então **não é fraude de preço**, mas vaza códigos. | Restringir o RLS de `cupons` (anon deixa de ler) **quebra esse preview**. Decidir: criar um endpoint `/api/validar-cupom` (servidor) e então fechar o RLS, ou aceitar a exposição. |
| H4 | **CSP (Content-Security-Policy)** | Não adicionei. O site tem MUITO script/estilo inline; um CSP errado quebra tudo. | Quero propor uma policy e testar num **preview** da Vercel antes de produção. Aprova? |
| H5 | **Redirect apex → www** | Canônico é `www`. Recomendado configurar no **painel da Vercel** (não por host no `vercel.json`, risco de loop). | Confirmar no painel. |

---

## 1. Resumo executivo

O projeto está, no geral, **bem construído em segurança de preço**: o servidor (`/api/criar-pagamento`) recalcula tudo a partir do banco e o webhook confirma o pagamento de volta na InfinitePay antes de marcar como pago. O escape XSS (`esc()`) já era usado na maioria dos pontos.

Os achados mais sérios desta passada e o que foi feito:

- 🔴 **XSS refletido** via `?cat=` no catálogo → **corrigido**.
- 🔴 **Overselling**: o servidor não checava estoque → **corrigido** na criação do pedido (a baixa pós-pagamento ficou como SQL pronto, pendente de deploy no banco).
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

**C2 — Overselling (estoque não verificado no servidor)** · `api/criar-pagamento.js`
O servidor montava o pedido sem checar estoque → era possível comprar mais que o disponível.
**Correção (na criação do pedido):** rejeita `estoque=0` (esgotado) e `qtd > estoque` (HTTP 409). `estoque=null` = não gerenciado (sem teto). ✅ Validado por testes 2c e 3.
**Pendente (baixa pós-pagamento):** `sql/02_baixar_estoque.sql` traz a RPC atômica `baixar_estoque()` (`update ... where estoque >= q`) + o trecho do webhook para chamá-la. **Não apliquei no webhook** para não deixar o código chamando uma função que ainda não existe no banco — aplicar SQL e patch **juntos** (ver H2/§7).

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

## 6. Pendentes de verificação humana (sem acesso ao banco de produção)

> O Supabase conectado a esta sessão só expõe o projeto `mmqfqlbojsbuuodfbilh` (inativo), **não** o de produção `kscqoczfdtoanjdoidtl`. Logo, schema/RLS/Storage **não puderam ser inspecionados** — gerei SQL pronto:

1. **`sql/03_verificacoes.sql`** — confirma colunas `ativo/destaque/created_at/estoque/preco_promo` em `produtos`/`variantes`, existência dos buckets `produtos` **e** `assets`, e faz dump das policies RLS atuais. Se as colunas/bucket não existirem, catálogo/admin quebram.
2. **`sql/01_rls_policies.sql`** — RLS correto: `anon`+`authenticated` podem **SELECT** em produtos/variantes; só `authenticated` escreve; `cupons` e `pedidos` fecham para anon. Inclui `notify pgrst, 'reload schema'`. **Ler os avisos H2/H3 antes de aplicar.**
3. **`sql/02_baixar_estoque.sql`** — RPC atômica de baixa de estoque + patch do webhook (aplicar juntos).

---

## 7. Recomendações (não aplicadas — fora do escopo seguro desta passada)

- **Consolidar o carrinho** num único `carrinho.js` na raiz, incluído por `<script>` em `produto.html` e `carrinho_raio_de_sol.html`, removendo as cópias inline (hoje há 2 cópias idênticas). Reduz risco de divergência. Refatoração que toca telas em produção → fazer com teste manual de cada fluxo.
- **Rate limiting** em `/api/criar-pagamento` (ex.: Vercel KV / Upstash) contra spam de pedidos.
- **Endpoint `/api/validar-cupom`** para mover 100% a validação de cupom ao servidor e então fechar o RLS de `cupons` (resolve H3).
- **Idempotência** de pedido: hoje o pedido é gravado antes do link da InfinitePay (se a InfinitePay falha, sobra pedido "aguardando"); e o `ref` não é enviado pelo cliente. Avaliar enviar um `ref` do cliente como chave de deduplicação.
- **Unificar semântica de estoque** entre todas as cópias do carrinho (servidor já trata `0 = esgotado`; as cópias inline tratam `0 = sem limite` para o teto de quantidade — inconsistência de cliente, sem impacto no preço pois o servidor manda).

---

## 8. Commits desta branch

```
fix(carrinho): troca placeholder via.placeholder.com por SVG local
fix(front): XSS refletido, JSON-LD Product, a11y e SEO
fix(pagamento): blinda criar-pagamento contra fraude e overselling
chore(seguranca): adiciona .gitignore (.env*) e remove api/carrinho.js órfão
```

Nenhuma mudança foi mesclada em `main`. Merge somente após sua revisão das decisões H1–H5.
