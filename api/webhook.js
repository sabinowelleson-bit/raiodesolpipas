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

    // 2) Marca como pago — só se ainda estiver "aguardando" (idempotente).
    //    Com a service_role key o RLS é ignorado, então o filtro é só um WHERE.
    const url =
      `${SUPABASE_URL}/rest/v1/pedidos` +
      `?pagamento_id=eq.${encodeURIComponent(orderNsu)}` +
      `&status=eq.aguardando`;

    const upd = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
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

    // Se 0 linhas baterem (pedido já estava pago), tudo bem — segue 200.
    console.log("[webhook] pedido confirmado como pago", orderNsu);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[webhook] erro inesperado", e);
    return res.status(400).json({ error: "exception" });
  }
}
