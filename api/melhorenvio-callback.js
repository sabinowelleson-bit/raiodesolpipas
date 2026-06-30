// api/melhorenvio-callback.js
// OAuth2 (authorization code) — USO ÚNICO, autorização inicial do Melhor Envio.
// O Melhor Envio redireciona pra cá com ?code=...; trocamos por access_token +
// refresh_token e salvamos na tabela melhorenvio_auth (via service_role).
//
// Depois disso, o /api/calcular-frete e o /api/criar-pagamento renovam sozinhos.

import { trocarCodigoPorToken, salvarAuth } from "./_melhorenvio.js";

export default async function handler(req, res) {
  // Pega o ?code (Vercel popula req.query; fallback no parse da URL).
  let code = req.query && req.query.code;
  if (!code && req.url) {
    try { code = new URL(req.url, "http://x").searchParams.get("code"); } catch { /* ignore */ }
  }
  const erroOAuth = (req.query && req.query.error) || null;

  if (erroOAuth) {
    return res.status(400).send("Autorização negada no Melhor Envio: " + String(erroOAuth));
  }
  if (!code) {
    return res.status(400).send("Faltou o parâmetro ?code da autorização do Melhor Envio.");
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error("[melhorenvio-callback] SUPABASE_SERVICE_ROLE_KEY ausente");
    return res.status(500).send("Configuração do servidor incompleta.");
  }

  try {
    const tokens = await trocarCodigoPorToken(code);
    await salvarAuth(serviceKey, tokens);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      "<!doctype html><meta charset='utf-8'><title>Melhor Envio conectado</title>" +
      "<div style='font-family:system-ui;max-width:520px;margin:60px auto;text-align:center'>" +
      "<h1>✅ Melhor Envio conectado!</h1>" +
      "<p>A autorização foi salva com sucesso. Já pode fechar esta aba — o cálculo de frete no checkout vai funcionar.</p>" +
      "</div>"
    );
  } catch (e) {
    console.error("[melhorenvio-callback] erro ao trocar code por token", e);
    return res.status(502).send("Não foi possível concluir a conexão com o Melhor Envio. Tente autorizar de novo.");
  }
}
