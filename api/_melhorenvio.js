// api/_melhorenvio.js
// Helper compartilhado da integração Melhor Envio (FASE 1: só COTAÇÃO de frete).
// NÃO é uma rota (prefixo "_" faz a Vercel ignorar este arquivo como função).
//
// Credenciais e config vêm SÓ de env vars (nunca hardcode/commit):
//   MELHOR_ENVIO_CLIENT_ID, MELHOR_ENVIO_SECRET, MELHOR_ENVIO_REDIRECT_URI
//   LOJA_CEP_ORIGEM, MELHOR_ENVIO_BASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  — passado pelas rotas (lê/escreve a tabela de tokens)
// (O User-Agent exigido pelo Melhor Envio fica fixo no código — não é segredo.)

const SUPABASE_URL = "https://kscqoczfdtoanjdoidtl.supabase.co";

// Produção: https://melhorenvio.com.br  | Sandbox: https://sandbox.melhorenvio.com.br
// (cotação só CONSULTA preço, não gasta saldo). Trocável pela env.
function baseUrl() {
  return (process.env.MELHOR_ENVIO_BASE_URL || "https://melhorenvio.com.br").replace(/\/+$/, "");
}
// O Melhor Envio EXIGE User-Agent com nome do app + e-mail de contato.
// Não é segredo — fica fixo no código.
const USER_AGENT = "Raio de Sol Pipas (sabinowelleson@gmail.com)";
function userAgent() {
  return USER_AGENT;
}

// Caixa/peso PADRÃO por item (cm / kg). Fáceis de ajustar depois.
const CAIXA_PADRAO = { largura: 16, altura: 6, comprimento: 16, peso: 0.3, seguro: 0 };

function limpaCep(cep) {
  return String(cep || "").replace(/\D/g, "");
}

// Monta o array "products" da cotação a partir dos itens do carrinho.
// Usa SÓ a quantidade (qtd) — assim a cotação do front (calcular-frete) e a
// reconferência no servidor (criar-pagamento) geram exatamente o mesmo input.
export function montarProdutos(itens) {
  return (Array.isArray(itens) ? itens : []).map((it, i) => ({
    id: String(it.variante_id || it.produto_id || i + 1),
    width: CAIXA_PADRAO.largura,
    height: CAIXA_PADRAO.altura,
    length: CAIXA_PADRAO.comprimento,
    weight: CAIXA_PADRAO.peso,
    insurance_value: CAIXA_PADRAO.seguro,
    quantity: Math.max(1, Math.floor(Number(it.qtd) || 1)),
  }));
}

// ---------- Supabase (tabela melhorenvio_auth, 1 linha id=1) ----------
function sbHeaders(serviceKey, extra) {
  return Object.assign(
    { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    extra || {}
  );
}

async function lerAuth(serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/melhorenvio_auth?id=eq.1&select=*`, {
    headers: sbHeaders(serviceKey),
  });
  if (!r.ok) throw new Error("supabase GET melhorenvio_auth " + r.status);
  const linhas = await r.json();
  return Array.isArray(linhas) && linhas[0] ? linhas[0] : null;
}

export async function salvarAuth(serviceKey, tokens) {
  // upsert na linha única (id=1)
  const body = {
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/melhorenvio_auth`, {
    method: "POST",
    headers: sbHeaders(serviceKey, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("supabase upsert melhorenvio_auth " + r.status + " " + t);
  }
}

// ---------- OAuth2 ----------
function expiraEm(segundos) {
  const ms = (Number(segundos) || 0) * 1000;
  return new Date(Date.now() + ms).toISOString();
}

async function postToken(payload) {
  const r = await fetch(`${baseUrl()}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.access_token) {
    throw new Error("melhorenvio oauth/token " + r.status + " " + JSON.stringify(data));
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token, // sempre retornado junto (pode vir rotacionado)
    expires_at: expiraEm(data.expires_in),
  };
}

// Autorização inicial (authorization_code) — usada pelo /api/melhorenvio-callback
export async function trocarCodigoPorToken(code) {
  return postToken({
    grant_type: "authorization_code",
    client_id: process.env.MELHOR_ENVIO_CLIENT_ID,
    client_secret: process.env.MELHOR_ENVIO_SECRET,
    redirect_uri: process.env.MELHOR_ENVIO_REDIRECT_URI,
    code,
  });
}

// Renovação (refresh_token)
async function renovarToken(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    client_id: process.env.MELHOR_ENVIO_CLIENT_ID,
    client_secret: process.env.MELHOR_ENVIO_SECRET,
    refresh_token: refreshToken,
    scope: "",
  });
}

// Devolve um access_token VÁLIDO. Renova se faltar < 3 dias p/ expirar
// (access_token dura ~30 dias). Atualiza a tabela (inclusive refresh_token novo).
const MARGEM_RENOVACAO_MS = 3 * 24 * 60 * 60 * 1000;

export async function tokenValido(serviceKey) {
  const row = await lerAuth(serviceKey);
  if (!row || !row.refresh_token) {
    const e = new Error("Melhor Envio ainda não foi autorizado (rode o callback).");
    e.code = "ME_NAO_AUTORIZADO";
    throw e;
  }
  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (row.access_token && exp - Date.now() > MARGEM_RENOVACAO_MS) {
    return row.access_token;
  }
  const novos = await renovarToken(row.refresh_token);
  await salvarAuth(serviceKey, novos);
  return novos.access_token;
}

// ---------- Cotação ----------
async function calcular(accessToken, cepDestino, produtos) {
  const cepOrigem = limpaCep(process.env.LOJA_CEP_ORIGEM);
  if (cepOrigem.length !== 8) {
    throw new Error("LOJA_CEP_ORIGEM ausente/ inválido nas env vars.");
  }
  const r = await fetch(`${baseUrl()}/api/v2/me/shipment/calculate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify({
      from: { postal_code: cepOrigem },
      to: { postal_code: limpaCep(cepDestino) },
      products: produtos,
      options: { receipt: false, own_hand: false },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("melhorenvio calculate " + r.status + " " + t);
  }
  const arr = await r.json().catch(() => null);
  return Array.isArray(arr) ? arr : [];
}

// API pública: cota o frete e devolve as opções LIMPAS (sem serviços com erro).
// Usado pelo /api/calcular-frete (front) E pelo /api/criar-pagamento (reconfere).
export async function cotarFrete(serviceKey, cepDestino, itens) {
  const token = await tokenValido(serviceKey);
  const produtos = montarProdutos(itens);
  const arr = await calcular(token, cepDestino, produtos);
  return arr
    .filter((s) => s && !s.error && s.price != null)
    .map((s) => ({
      servico_id: s.id,
      transportadora: (s.company && s.company.name) || "",
      servico: s.name || "",
      preco: Math.round(Number(s.custom_price != null ? s.custom_price : s.price) * 100) / 100,
      prazo: s.custom_delivery_time != null ? s.custom_delivery_time : s.delivery_time,
    }));
}
