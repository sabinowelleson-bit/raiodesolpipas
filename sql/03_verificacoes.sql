-- ============================================================================
-- 03_verificacoes.sql  —  Consultas para CONFERIR se o código bate com o schema
-- Rode no projeto de PRODUÇÃO. São SOMENTE LEITURA (não alteram nada).
-- O Claude não tem acesso ao projeto kscqoczfdtoanjdoidtl, então estes pontos
-- ficam "pendentes de verificação" até alguém rodar isto.
-- ============================================================================

-- 1) Colunas que o código assume em produtos: ativo, destaque, created_at, estoque, preco_promo
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'produtos'
order by ordinal_position;

-- 2) Colunas em variantes: produto_id (bigint), ativo, estoque, preco, preco_promo
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'variantes'
order by ordinal_position;

-- 3) Colunas em pedidos (itens jsonb, status, pagamento_id, etc.)
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'pedidos'
order by ordinal_position;

-- 4) Buckets do Storage — o app.js usa storage.from('produtos') e 'assets'.
--    Confirme que AMBOS existem (senão upload/imagens quebram).
select id, name, public from storage.buckets order by name;

-- 5) Dump de TODAS as policies RLS atuais (compare com 01_rls_policies.sql).
--    Procure especialmente por: policy de INSERT anônimo em 'pedidos' (remover)
--    e leitura anônima em 'cupons' (remover).
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 6) RLS está habilitado em todas as tabelas de negócio?
select relname as tabela, relrowsecurity as rls_on
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('produtos','variantes','cupons','pedidos');
