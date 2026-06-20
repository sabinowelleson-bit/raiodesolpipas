-- ============================================================================
-- 01_rls_policies.sql  —  Políticas RLS (Raio de Sol Pipas)
-- PENDENTE DE VERIFICAÇÃO HUMANA — rode no SQL Editor do projeto de PRODUÇÃO
-- (kscqoczfdtoanjdoidtl). O Claude NÃO tem acesso a esse projeto, então este
-- SQL NÃO foi testado contra o banco real. Revise antes de aplicar.
--
-- ARMADILHA CONHECIDA (deste projeto): policy de SELECT precisa cobrir
-- anon E authenticated, senão o REST/PostgREST falha silenciosamente mesmo
-- funcionando no SQL Editor. Por isso usamos "to anon, authenticated".
-- Sempre rode o NOTIFY no fim para recarregar o schema do PostgREST.
-- ============================================================================

-- ---------- PRODUTOS: leitura pública, escrita só autenticado ----------
alter table public.produtos enable row level security;

drop policy if exists "produtos_select_public" on public.produtos;
create policy "produtos_select_public"
  on public.produtos for select
  to anon, authenticated
  using (true);

drop policy if exists "produtos_write_auth" on public.produtos;
create policy "produtos_write_auth"
  on public.produtos for all
  to authenticated
  using (true) with check (true);

-- ---------- VARIANTES: leitura pública, escrita só autenticado ----------
alter table public.variantes enable row level security;

drop policy if exists "variantes_select_public" on public.variantes;
create policy "variantes_select_public"
  on public.variantes for select
  to anon, authenticated
  using (true);

drop policy if exists "variantes_write_auth" on public.variantes;
create policy "variantes_write_auth"
  on public.variantes for all
  to authenticated
  using (true) with check (true);

-- ---------- CUPONS: NÃO exponha a tabela ao anon ----------
-- O endpoint /api/criar-pagamento valida o cupom com a service_role (ignora RLS),
-- então o front NÃO precisa mais ler cupons com a anon key. Restrinja leitura ao
-- autenticado (admin). ATENÇÃO: hoje carrinho_raio_de_sol.html lê cupons via anon
-- para mostrar o desconto na hora — ao aplicar isto, esse preview para de funcionar
-- até mover a validação do cupom para um endpoint no servidor (ver RELATORIO §Pendências).
alter table public.cupons enable row level security;

drop policy if exists "cupons_anon_select" on public.cupons;  -- remove leitura anônima, se existir
drop policy if exists "cupons_select_auth" on public.cupons;
create policy "cupons_select_auth"
  on public.cupons for select
  to authenticated
  using (true);

drop policy if exists "cupons_write_auth" on public.cupons;
create policy "cupons_write_auth"
  on public.cupons for all
  to authenticated
  using (true) with check (true);

-- ---------- PEDIDOS: ninguém com anon/authenticated mexe direto ----------
-- O servidor grava/atualiza pedidos com a service_role (ignora RLS). Logo:
--   * REMOVA qualquer policy de INSERT anônimo em pedidos.
--   * Só o admin autenticado precisa LER (para o painel).
-- IMPORTANTE: só aplique a remoção do INSERT anônimo DEPOIS de confirmar que o
-- /api/criar-pagamento está deployado e gravando pedidos (senão o checkout para).
alter table public.pedidos enable row level security;

drop policy if exists "pedidos_anon_insert" on public.pedidos;  -- remove INSERT anônimo, se existir
drop policy if exists "pedidos_select_auth" on public.pedidos;
create policy "pedidos_select_auth"
  on public.pedidos for select
  to authenticated
  using (true);

drop policy if exists "pedidos_write_auth" on public.pedidos;
create policy "pedidos_write_auth"
  on public.pedidos for all
  to authenticated
  using (true) with check (true);

-- ---------- Recarrega o schema do PostgREST (OBRIGATÓRIO) ----------
notify pgrst, 'reload schema';
