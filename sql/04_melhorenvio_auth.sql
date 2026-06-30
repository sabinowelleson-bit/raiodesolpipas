-- ============================================================================
-- 04_melhorenvio_auth.sql  —  Tokens rotativos do Melhor Envio (FASE 1: cotação)
-- Rode no SQL Editor do projeto de PRODUÇÃO. O Claude não acessa esse banco.
--
-- Tabela de 1 linha (id=1) com access_token/refresh_token/expires_at.
-- RLS LIGADO e SEM policies => anon e authenticated NÃO acessam.
-- Só a service_role (usada pelas funções /api) lê/escreve (ignora RLS).
-- ============================================================================

create table if not exists public.melhorenvio_auth (
  id            int primary key default 1,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz default now(),
  constraint melhorenvio_auth_singleton check (id = 1)
);

alter table public.melhorenvio_auth enable row level security;

-- Sem CREATE POLICY de propósito: com RLS ligado e nenhuma policy, anon e
-- authenticated ficam sem acesso. A service_role ignora RLS.
revoke all on table public.melhorenvio_auth from anon, authenticated;

notify pgrst, 'reload schema';
