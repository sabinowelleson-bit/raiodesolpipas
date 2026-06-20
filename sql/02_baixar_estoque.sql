-- ============================================================================
-- 02_baixar_estoque.sql  —  Baixa de estoque atômica ao confirmar pagamento
-- PENDENTE DE VERIFICAÇÃO HUMANA — rode no projeto de PRODUÇÃO e só então
-- aplique o trecho do webhook indicado no RELATORIO (§Pendências). NÃO testado
-- contra o banco real (o Claude não tem acesso ao projeto kscqoczfdtoanjdoidtl).
--
-- Por que RPC: o PostgREST não faz "estoque = estoque - q" atômico via REST.
-- Esta função decrementa com WHERE estoque >= q (trata corrida) item a item,
-- lendo os itens gravados no próprio pedido. É idempotente por design quando
-- chamada uma vez na transição aguardando->pago (o webhook só baixa nesse momento).
--
-- Tipos confirmados em produção (2026-06-20):
--   variantes.id     uuid     -> variante_id é cast p/ ::uuid
--   variantes.estoque integer NOT NULL  -> a baixa acontece aqui
--   produtos.id      bigint   -> produto_id é cast p/ ::bigint (itens sem variante)
--   pedidos.id       uuid     -> p_pedido_id uuid
--   pedidos.itens    jsonb    -> jsonb_array_elements(itens)
-- ============================================================================

create or replace function public.baixar_estoque(p_pedido_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  q    int;
begin
  for item in
    select jsonb_array_elements(itens) from public.pedidos where id = p_pedido_id
  loop
    q := coalesce((item->>'qtd')::int, 0);
    if q <= 0 then
      continue;  -- defesa: ignora qtd inválida (não deixa "aumentar" estoque)
    end if;

    if (item->>'variante_id') is not null then
      -- Estoque mora na variante (variantes.estoque, integer NOT NULL).
      update public.variantes
         set estoque = estoque - q
       where id = (item->>'variante_id')::uuid
         and estoque >= q;
    else
      -- Item sem variante: baixa no produto (se o estoque for gerenciado).
      update public.produtos
         set estoque = estoque - q
       where id = (item->>'produto_id')::bigint
         and estoque is not null
         and estoque >= q;
    end if;
  end loop;
end;
$$;

-- Só a service_role precisa chamar (o webhook usa service_role).
revoke all on function public.baixar_estoque(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- PATCH do webhook (api/webhook.js) — aplicar JUNTO com a função acima.
-- Depois de marcar o pedido como "pago" com sucesso (e só se 1 linha mudou),
-- chame a RPC. Falha na baixa NÃO deve falhar o webhook (o pagamento já existe):
--
--   // logo após o PATCH de status que retornou ok:
--   try {
--     await fetch(`${SUPABASE_URL}/rest/v1/rpc/baixar_estoque`, {
--       method: "POST",
--       headers: {
--         apikey: serviceKey,
--         Authorization: `Bearer ${serviceKey}`,
--         "Content-Type": "application/json",
--       },
--       body: JSON.stringify({ p_pedido_id: /* id do pedido */ }),
--     });
--   } catch (e) { console.error("[webhook] baixa de estoque falhou", e); }
--
-- OBS: o webhook hoje localiza o pedido por pagamento_id (a ref RS-...). Para
-- chamar a RPC é preciso o id (uuid) do pedido. Opções:
--   (a) no PATCH use Prefer: return=representation e leia o id da resposta; ou
--   (b) faça um GET pedidos?pagamento_id=eq.<ref>&select=id antes da RPC.
-- ----------------------------------------------------------------------------
