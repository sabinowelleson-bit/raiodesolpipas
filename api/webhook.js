// /api/webhook.js
// Confirmação automática de pagamento da InfinitePay.
// A InfinitePay faz POST aqui após o pagamento. A gente VERIFICA de volta
// (payment_check) antes de confiar e, se confirmado, marca o pedido como "pago".
//
// Variável de ambiente necessária na Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (chave service_role do Supabase — SECRETA)
//
// O handle da InfinitePay é público (a InfiniteTag), então pode ficar no código.

const SUPABASE_URL = "https://kscqoczfdtoanjdoidtl.supabase.co";
const HANDLE = "raiodesolpipas"; // InfiniteTag, sem o "$"

export default async function handler(req, res) {
  // A InfinitePay envia POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error("[webhook] SUPABASE_SERVICE_ROLE_KEY ausente");
    // erro de configuração nosso -> 400 faz a InfinitePay tentar de novo depois
    return res.status(400).json({ error: "config" });
  }

  // Lê o corpo da notificação (a Vercel costuma entregar já como objeto)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const orderNsu = body.order_nsu;                 // = nossa ref RS-... (guardada em pagamento_id)
  const transactionNsu = body.transaction_nsu;
  const slug = body.invoice_slug || body.slug;     // código da fatura
  const captureMethod = body.capture_method || null; // pix | credit_card | ...

  // Sem identificador do pedido não há o que confirmar
  if (!orderNsu) {
    console.warn("[webhook] notificação sem order_nsu");
    return res.status(200).json({ ignored: true });
  }
  // Sem esses dados não dá pra verificar com segurança -> 400 pra tentar de novo
  if (!transactionNsu || !slug) {
    console.warn("[webhook] faltam transaction_nsu/slug", orderNsu);
    return res.status(400).json({ error: "incompleto" });
  }

  try {
    // 1) ANTI-FRAUDE: confirma com a própria InfinitePay.
    //    payment_check usa só o handle (público) + os dados que vieram no webhook.
    //    Isso impede que alguém forje uma notificação de "pago" falsa.
    const check = await fetch("https://api.checkout.infinitepay.io/payment_check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: HANDLE,
        order_nsu: String(orderNsu),
        transaction_nsu: String(transactionNsu),
        slug: String(slug),
      }),
    });
    const data = await check.json().catch(() => null);
    const paid = !!(data && data.success && data.paid);

    if (!paid) {
      console.warn("[webhook] payment_check NÃO confirmou pago", { orderNsu, data });
      // pode ser timing -> deixa a InfinitePay reenviar
      return res.status(400).json({ error: "nao confirmado" });
    }

    // 1.5) CONFERE O VALOR: a fatura (data.amount, em centavos) tem que bater com o
    //      total do pedido (com frete, pós-cupom). NÃO usa data.paid_amount, que pode
    //      ser MAIOR por juros de parcelamento. Tolerância de 1 centavo.
    let pedidoTotalCent = null;
    try {
      const gp = await fetch(
        `${SUPABASE_URL}/rest/v1/pedidos` +
        `?pagamento_id=eq.${encodeURIComponent(orderNsu)}` +
        `&select=total&limit=1`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      if (!gp.ok) {
        const t = await gp.text().catch(() => "");
        console.error("[webhook] falha ao buscar total do pedido", gp.status, t);
        return res.status(400).json({ error: "lookup" }); // transitório -> InfinitePay reenvia
      }
      const linhas = await gp.json().catch(() => []);
      const ped = Array.isArray(linhas) ? linhas[0] : null;
      if (ped && ped.total != null) pedidoTotalCent = Math.round(Number(ped.total) * 100);
    } catch (e) {
      console.error("[webhook] erro ao buscar total do pedido", e);
      return res.status(400).json({ error: "lookup" }); // transitório -> reenvia
    }

    const valorFaturaCent = Number(data.amount);
    if (
      pedidoTotalCent == null ||
      !Number.isFinite(valorFaturaCent) ||
      Math.abs(valorFaturaCent - pedidoTotalCent) > 1
    ) {
      // Não bate -> NÃO transiciona. 200 pra InfinitePay não reenviar; o pedido fica
      // "aguardando" pra conferência manual pelo log.
      console.error("[webhook] valor da fatura DIVERGE do total do pedido — mantém aguardando", {
        orderNsu,
        amount_fatura_centavos: valorFaturaCent,
        total_pedido_centavos: pedidoTotalCent,
        paid_amount_centavos: data && data.paid_amount,
      });
      return res.status(200).json({ ok: false, motivo: "valor_diverge" });
    }

    // 2) Marca como pago — só se ainda estiver "aguardando" (idempotente).
    //    Com a service_role key o RLS é ignorado, então o filtro é só um WHERE.
    // return=representation + select=id: a resposta traz as linhas REALMENTE
    // atualizadas. Como o filtro exige status=aguardando, só a 1ª confirmação
    // muda linha; um webhook duplicado bate 0 linhas e NÃO baixa estoque de novo.
    const url =
      `${SUPABASE_URL}/rest/v1/pedidos` +
      `?pagamento_id=eq.${encodeURIComponent(orderNsu)}` +
      `&status=eq.aguardando` +
      `&select=id`;

    const upd = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "pago",
        pagamento_tipo: captureMethod || (data && data.capture_method) || null,
      }),
    });

    if (!upd.ok) {
      const t = await upd.text().catch(() => "");
      console.error("[webhook] falha ao atualizar pedido", upd.status, t);
      return res.status(400).json({ error: "update" });
    }

    const linhas = await upd.json().catch(() => []);
    const pedido = Array.isArray(linhas) ? linhas[0] : null;

    // Só baixa estoque se ESTE webhook fez a transição aguardando->pago (1 linha).
    // Webhook duplicado => 0 linhas => pula (evita baixar estoque duas vezes).
    if (pedido && pedido.id) {
      try {
        const baixa = await fetch(`${SUPABASE_URL}/rest/v1/rpc/baixar_estoque`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_pedido_id: pedido.id }),
        });
        if (!baixa.ok) {
          const bt = await baixa.text().catch(() => "");
          console.error("[webhook] baixa de estoque falhou", baixa.status, bt);
        }
      } catch (e) {
        // O pagamento já está confirmado: NÃO derruba o webhook por falha na baixa.
        console.error("[webhook] baixa de estoque (exceção)", e);
      }
    }

    // 0 linhas (pedido já estava pago) também segue 200 — idempotente.
    console.log("[webhook] pedido confirmado como pago", orderNsu);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[webhook] erro inesperado", e);
    return res.status(400).json({ error: "exception" });
  }
}
