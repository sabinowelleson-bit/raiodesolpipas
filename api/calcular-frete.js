// api/calcular-frete.js
// Cotação de frete no checkout (FASE 1 — só consulta preço, não compra etiqueta).
// Recebe { cep (destino), itens: [{produto_id, variante_id, qtd}] }.
// Origem = LOJA_CEP_ORIGEM (env). Devolve as opções limpas pro front.

import { cotarFrete } from "./_melhorenvio.js";

const ALLOWED_ORIGINS = [
  "https://www.raiodesolpipas.com.br",
  "https://raiodesolpipas.com.br",
];

export default async function handler(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ erro: "Origem não autorizada." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido. Use POST." });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error("[calcular-frete] SUPABASE_SERVICE_ROLE_KEY ausente");
    return res.status(500).json({ erro: "Cálculo de frete indisponível no momento." });
  }

  try {
    const { cep, itens } = req.body || {};

    const cepLimpo = String(cep || "").replace(/\D/g, "");
    if (cepLimpo.length !== 8) {
      return res.status(400).json({ erro: "Informe um CEP válido (8 dígitos)." });
    }
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: "Carrinho vazio." });
    }

    const opcoes = await cotarFrete(serviceKey, cepLimpo, itens);
    if (!opcoes.length) {
      return res.status(200).json({ opcoes: [], aviso: "Nenhuma transportadora atende este CEP no momento." });
    }
    // Ordena da mais barata pra mais cara.
    opcoes.sort((a, b) => a.preco - b.preco);
    return res.status(200).json({ opcoes });
  } catch (e) {
    if (e && e.code === "ME_NAO_AUTORIZADO") {
      console.error("[calcular-frete] Melhor Envio não autorizado");
      return res.status(503).json({ erro: "Frete temporariamente indisponível. Tente em instantes." });
    }
    console.error("[calcular-frete] erro", e);
    return res.status(502).json({ erro: "Não foi possível calcular o frete agora. Tente novamente." });
  }
}
