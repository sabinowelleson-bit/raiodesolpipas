# Auditoria de segurança + qualidade (branch `auditoria/varredura`)

Varredura completa do repo (estático + funções `/api` + integração Supabase/InfinitePay).
**Nada mesclado** — PR para revisão. Detalhes em `RELATORIO-AUDITORIA.md`.

## Mudanças por severidade

### 🔴 Críticos
- **XSS refletido** no catálogo: `?cat=` ia cru pro `innerHTML` (`?cat=<img src=x onerror=...>` executava) → escapado. (`catalogo.html`)
- **Overselling**: servidor não checava estoque → agora rejeita `estoque=0` (esgotado) e `qtd > estoque` na criação do pedido. (`api/criar-pagamento.js`) — baixa de estoque pós-pagamento entregue como SQL pronto (`sql/02_baixar_estoque.sql`), pendente de deploy no banco.

### 🟠 Altos
- **Integridade de variante**: valida que a variante pertence ao produto enviado e está `ativo=true`; rejeita produto/variante inativos. (`api/criar-pagamento.js`)
- **Quantidade abusiva**: normalizada para inteiro ≥1 com teto de estoque.
- **`.gitignore` novo**: bloqueia commit de `.env*`/segredos.
- **Allowlist de Origin** em `/api/criar-pagamento` (anti-abuso cross-origin) — inclui `www` e apex.

### 🟡 Médios
- `ref` de pedido com sufixo aleatório (anti-colisão em double-click).
- `esc()` nas URLs de imagem em `src` (`produto.html`, `app.js`).
- Troca de `via.placeholder.com` por SVG data-URI local (`carrinho_raio_de_sol.html`).
- **Product JSON-LD** (schema.org) injetado na PDP após carregar o produto.

### 🟢 Baixos
- `robots.txt`/`sitemap.xml` no domínio canônico `www`; robots bloqueia carrinho e pagamento-concluido.
- a11y: `label`/`aria-label` no controle de quantidade da PDP.
- Remoção do órfão `api/carrinho.js` (código de cliente dentro de `/api`, duplicado inline).

## Validação
- `node --check` em todo JS + parser nos `<script>` inline (0 erros).
- **21/21** testes anti-fraude passam: `node tests/criar-pagamento.test.mjs`.

## ⚠️ Decisões humanas pendentes (NÃO decididas no PR)
- **H1** "12x sem juros" / "5% off no Pix" exibidos, mas servidor cobra cheio → aplicar de verdade ou ajustar texto.
- **H2/H3** RLS: remover INSERT anônimo em `pedidos` só após confirmar deploy; fechar `cupons` exige `/api/validar-cupom`.
- **H4** CSP — propor e testar em preview antes de produção.
- **H5** Redirect apex→www no painel da Vercel.

## Pendente de verificação (sem acesso ao projeto Supabase de produção)
Rodar `sql/03_verificacoes.sql` (colunas `ativo/destaque/created_at`, buckets `produtos`/`assets`, dump de RLS) e aplicar `sql/01_rls_policies.sql` / `sql/02_baixar_estoque.sql` conforme o relatório.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
