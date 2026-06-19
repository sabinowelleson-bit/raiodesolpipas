// /api/criar-pagamento.js
// Gera o link de pagamento na InfinitePay COM OS PREÇOS CALCULADOS NO SERVIDOR.
//
// SEGURANÇA: o navegador manda apenas IDs de produto + quantidades + cupom + dados
// do cliente. O servidor busca os preços REAIS no Supabase, valida o cupom, calcula
// o total, grava o pedido (com a service_role) e cria o link de pagamento. Assim o
// cliente não consegue forjar preço/desconto.
//
// Variável de ambiente necessária na Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (a mesma que o webhook já usa)

const SUPABASE_URL = "https://kscqoczfdtoanjdoidtl.supabase.co";
const HANDLE = "raiodesolpipas";
const INFINITYPAY_URL = "https://api.checkout.infinitepay.io/links";
const SITE_URL = "https://www.raiodesolpipas.com.br";

// Fonte da verdade dos fretes (no servidor, não no cliente).
const FRETES = {
  pac:      { valor: 18.90, label: "PAC" },
  sedex:    { valor: 32.50, label: "SEDEX" },
  retirada: { valor: 0,     label: "Retirar na loja" },
};

function precoReal(row) {
  const preco = Number(row.preco) || 0;
  const promo = row.preco_promo != null ? Number(row.preco_promo) : null;
  return (promo != null && promo > 0 && promo < preco) ? promo : preco;
}

async function sbGet(path, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!r.ok) throw new Error("supabase GET " + r.status);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido. Use POST." });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error("[criar-pagamento] SUPABASE_SERVICE_ROLE_KEY ausente");
    return res.status(500).json({ erro: "Pagamento indisponível no momento." });
  }

  try {
    const { itens, frete_tipo, cupom, cliente } = req.body || {};

    // 1) Validações básicas
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: "Carrinho vazio." });
    }
    if (!cliente || !cliente.nome || !cliente.cep || !cliente.end || !cliente.tel) {
      return res.status(400).json({ erro: "Dados de entrega incompletos." });
    }
    const frete = FRETES[frete_tipo];
    if (!frete) {
      return res.status(400).json({ erro: "Opção de frete inválida." });
    }

    // 2) Busca preços REAIS no Supabase
    const produtoIds = [...new Set(
      itens.map((i) => parseInt(i.produto_id, 10)).filter((n) => !isNaN(n))
    )];
    const varianteIds = [...new Set(itens.map((i) => i.variante_id).filter(Boolean))];
    if (produtoIds.length === 0) {
      return res.status(400).json({ erro: "Itens inválidos." });
    }

    const produtos = await sbGet(`produtos?id=in.(${produtoIds.join(",")})&select=*`, serviceKey);
    const prodMap = {};
    produtos.forEach((p) => { prodMap[String(p.id)] = p; });

    let varMap = {};
    if (varianteIds.length > 0) {
      const variantes = await sbGet(
        `variantes?id=in.(${varianteIds.map(encodeURIComponent).join(",")})&select=*`,
        serviceKey
      );
      variantes.forEach((v) => { varMap[String(v.id)] = v; });
    }

    // 3) Monta os itens autoritativos + subtotal
    const itensFinais = [];
    let subtotal = 0;
    for (const it of itens) {
      const qtd = Math.max(1, Number(it.qtd) || 1);
      let nome, preco, cor = "", tamanho = "";

      if (it.variante_id) {
        const v = varMap[String(it.variante_id)];
        if (!v) return res.status(400).json({ erro: "Um item do carrinho não está mais disponível." });
        const p = prodMap[String(v.produto_id)] || prodMap[String(it.produto_id)];
        nome = p ? p.nome : "Produto";
        preco = precoReal(v);
        cor = v.cor || "";
        tamanho = v.tamanho || "";
      } else {
        const p = prodMap[String(it.produto_id)];
        if (!p) return res.status(400).json({ erro: "Um item do carrinho não está mais disponível." });
        nome = p.nome;
        preco = precoReal(p);
      }

      subtotal += preco * qtd;
      itensFinais.push({
        produto_id: it.produto_id,
        variante_id: it.variante_id || null,
        nome, cor, tamanho, preco, qtd,
      });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const freteVal = frete.valor;

    // 4) Valida o cupom NO SERVIDOR e calcula o desconto
    let desconto = 0;
    if (cupom && String(cupom).trim()) {
      const codigo = String(cupom).trim().toUpperCase();
      const cupons = await sbGet(
        `cupons?codigo=eq.${encodeURIComponent(codigo)}&ativo=eq.true&select=*`,
        serviceKey
      );
      const c = cupons && cupons[0];
      if (c) {
        let valido = true;
        if (c.validade) {
          const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
          const venc = new Date(String(c.validade).slice(0, 10) + "T00:00:00");
          if (venc < hoje) valido = false;
        }
        if (valido) {
          if (c.tipo === "percentual") desconto = subtotal * (Number(c.valor) || 0) / 100;
          else if (c.tipo === "fixo") desconto = Math.min(Number(c.valor) || 0, subtotal);
          else if (c.tipo === "frete_gratis") desconto = freteVal;
          desconto = Math.round(desconto * 100) / 100;
          if (desconto < 0) desconto = 0;
          if (desconto > subtotal + freteVal) desconto = subtotal + freteVal;
        }
      }
    }

    const total = Math.round((subtotal + freteVal - desconto) * 100) / 100;
    if (total <= 0) {
      return res.status(400).json({ erro: "O total do pedido precisa ser maior que zero." });
    }

    // 5) Grava o pedido (status aguardando) com a service_role
    const ref = "RS-" + Date.now().toString(36).toUpperCase();
    const insPedido = await fetch(`${SUPABASE_URL}/rest/v1/pedidos`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        cliente_nome: String(cliente.nome),
        cliente_email: cliente.email ? String(cliente.email) : null,
        cliente_tel: String(cliente.tel),
        cliente_cep: String(cliente.cep),
        cliente_end: String(cliente.end),
        itens: itensFinais,
        subtotal, frete: freteVal, desconto, total,
        status: "aguardando",
        frete_tipo: frete.label,
        pagamento_id: ref,
      }),
    });
    if (!insPedido.ok) {
      const t = await insPedido.text().catch(() => "");
      console.error("[criar-pagamento] falha ao gravar pedido", insPedido.status, t);
      return res.status(502).json({ erro: "Não foi possível registrar o pedido." });
    }

    // 6) Itens pra InfinitePay (em centavos). Com desconto, consolida em 1 item.
    let itemsPay;
    if (desconto > 0) {
      itemsPay = [{
        quantity: 1,
        price: Math.round(total * 100),
        description: "Pedido Raio de Sol Pipas (com desconto)",
      }];
    } else {
      itemsPay = itensFinais.map((it) => {
        let desc = it.nome;
        const extra = [it.cor, it.tamanho].filter(Boolean);
        if (extra.length) desc += " (" + extra.join(" \u00b7 ") + ")";
        return { quantity: it.qtd, price: Math.round(it.preco * 100), description: desc };
      });
      if (freteVal > 0) {
        itemsPay.push({ quantity: 1, price: Math.round(freteVal * 100), description: "Frete (" + frete.label + ")" });
      }
    }

    // 7) Cria o link de pagamento
    const resposta = await fetch(INFINITYPAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: HANDLE,
        items: itemsPay,
        order_nsu: ref,
        redirect_url: `${SITE_URL}/pagamento-concluido.html`,
        webhook_url: `${SITE_URL}/api/webhook`,
      }),
    });
    if (!resposta.ok) {
      const t = await resposta.text().catch(() => "");
      console.error("[criar-pagamento] InfinitePay erro", resposta.status, t);
      return res.status(502).json({ erro: "Não foi possível gerar o pagamento." });
    }
    const dados = await resposta.json();
    return res.status(200).json({ url: dados.url });
  } catch (e) {
    console.error("[criar-pagamento] erro inesperado", e);
    return res.status(500).json({ erro: "Erro interno." });
  }
}
