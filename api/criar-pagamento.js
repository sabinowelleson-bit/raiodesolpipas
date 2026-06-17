// Função-ponte: recebe o pedido do site e gera um link de pagamento no Infinity Pay.
// Roda na Vercel (Serverless Function). O navegador do cliente NÃO chama o Infinity Pay
// diretamente — ele chama esta função, e esta função chama o Infinity Pay.

// A handle (InfiniteTag) da loja. É pública, então pode ficar aqui.
const HANDLE = "raiodesolpipas";

// Endereço da API de checkout do Infinity Pay.
const INFINITYPAY_URL = "https://api.checkout.infinitepay.io/links";

// O domínio do site, usado para redirecionar o cliente depois do pagamento.
const SITE_URL = "https://www.raiodesolpipas.com.br";

export default async function handler(req, res) {
  // 1) Só aceita requisições do tipo POST (que é como o site vai mandar o pedido).
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido. Use POST." });
  }

  try {
    // 2) Pega os itens do carrinho que o site enviou.
    //    Esperamos algo como: { itens: [{ descricao, quantidade, preco }] }
    //    onde "preco" vem em REAIS (ex: 25.90).
    const { itens, order_nsu, desconto } = req.body || {};

    // 3) Validação básica: precisa ter pelo menos 1 item.
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: "Nenhum item no pedido." });
    }

    // 4) Converte os itens para o formato que o Infinity Pay exige.
    //    IMPORTANTE: o Infinity Pay quer o preço em CENTAVOS (R$10,00 = 1000).
    //    Por isso multiplicamos por 100 e arredondamos.
    const itemsFormatados = itens.map((item) => ({
      quantity: Number(item.quantidade) || 1,
      price: Math.round(Number(item.preco) * 100),
      description: String(item.descricao || "Produto"),
    }));

    // 4b) Aplica o desconto de cupom, se houver (desconto vem em REAIS).
    //     Quando há desconto, consolidamos tudo em UM único item com o valor
    //     final já abatido — evita preço negativo por linha e erro de arredondamento.
    const descontoCents = Math.round((Number(desconto) || 0) * 100);
    let itemsFinais = itemsFormatados;
    if (descontoCents > 0) {
      const totalCents = itemsFormatados.reduce((s, it) => s + it.price * it.quantity, 0);
      let finalCents = totalCents - descontoCents;
      if (finalCents < 0) finalCents = 0;
      itemsFinais = [
        {
          quantity: 1,
          price: finalCents,
          description: "Pedido Raio de Sol Pipas (com desconto)",
        },
      ];
    }

    // 5) Monta o corpo da requisição para o Infinity Pay.
    const payload = {
      handle: HANDLE,
      items: itemsFinais,
      // order_nsu = número do pedido no nosso sistema (opcional, mas útil pra rastrear).
      order_nsu: order_nsu || `pedido-${Date.now()}`,
      // Pra onde o cliente volta depois de pagar.
      redirect_url: `${SITE_URL}/pagamento-concluido.html`,
      // Pra onde a InfinitePay AVISA que o pagamento foi feito (confirmação automática).
      webhook_url: `${SITE_URL}/api/webhook`,
    };

    // 6) Chama o Infinity Pay.
    const resposta = await fetch(INFINITYPAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // 7) Se o Infinity Pay devolver erro, repassa isso pro site.
    if (!resposta.ok) {
      const textoErro = await resposta.text();
      return res.status(502).json({
        erro: "Não foi possível gerar o pagamento.",
        detalhe: textoErro,
      });
    }

    // 8) Sucesso: o Infinity Pay devolve { url: "..." } com o link de pagamento.
    const dados = await resposta.json();
    return res.status(200).json({ url: dados.url });
  } catch (e) {
    // 9) Qualquer erro inesperado cai aqui.
    return res.status(500).json({ erro: "Erro interno.", detalhe: String(e) });
  }
}
