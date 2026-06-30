// tests/melhorenvio.test.mjs
// Testa a integração Melhor Envio (cotação) com TUDO mockado (sem rede):
// helper de token (valida/renova), limpeza das opções, endpoint /calcular-frete
// e a RECONFERÊNCIA do frete no /criar-pagamento (nunca confia no cliente).
//
// Rodar: node tests/melhorenvio.test.mjs

// --- env de teste (lidas dentro das funções do helper) ---
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.MELHOR_ENVIO_CLIENT_ID = "cid";
process.env.MELHOR_ENVIO_SECRET = "sec";
process.env.MELHOR_ENVIO_REDIRECT_URI = "https://site/api/melhorenvio-callback";
process.env.LOJA_CEP_ORIGEM = "68552-000";
process.env.MELHOR_ENVIO_BASE_URL = "https://melhorenvio.com.br";

const { cotarFrete, tokenValido, trocarCodigoPorToken } = await import("../api/_melhorenvio.js");
const calcularFreteHandler = (await import("../api/calcular-frete.js")).default;
const criarPagamento = (await import("../api/criar-pagamento.js")).default;

// --- estado mockável ---
let authRow = null;       // linha de melhorenvio_auth
let savedAuth = null;     // último upsert
let pedidoGravado = null; // último pedido
let tokenCalls = [];      // bodies enviados ao /oauth/token
let calcCalls = [];       // bodies enviados ao /calculate

const PRODUTOS = [{ id: 1, nome: "Pipa Azul", preco: 100, preco_promo: null, estoque: 5, ativo: true }];

function parseInList(url) {
  const m = url.match(/id=in\.\(([^)]*)\)/);
  return m ? m[1].split(",").filter(Boolean).map(decodeURIComponent) : [];
}

function CALC_RESPONSE() {
  return [
    { id: 1, name: "PAC", price: "18.90", custom_price: "18.90", delivery_time: 8, custom_delivery_time: 8, company: { id: 1, name: "Correios" } },
    { id: 2, name: "SEDEX", price: "32.50", custom_price: "32.50", delivery_time: 3, custom_delivery_time: 3, company: { id: 1, name: "Correios" } },
    { id: 3, name: ".Package", error: "CEP fora de cobertura", company: { id: 2, name: "Jadlog" } },
  ];
}

global.fetch = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const ok = (json, status = 200) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });

  if (url.endsWith("/oauth/token")) { tokenCalls.push(JSON.parse(opts.body)); return ok({ access_token: "AT-" + JSON.parse(opts.body).grant_type, refresh_token: "RT-new", expires_in: 60 * 60 * 24 * 30 }); }
  if (url.includes("/api/v2/me/shipment/calculate")) { calcCalls.push(JSON.parse(opts.body)); return ok(CALC_RESPONSE()); }
  if (url.includes("/rest/v1/melhorenvio_auth") && method === "GET") return ok(authRow ? [authRow] : []);
  if (url.includes("/rest/v1/melhorenvio_auth") && method === "POST") { savedAuth = JSON.parse(opts.body); return ok({}, 201); }
  if (url.includes("/rest/v1/produtos") && method === "GET") { const ids = parseInList(url).map((n) => parseInt(n, 10)); return ok(PRODUTOS.filter((p) => ids.includes(p.id))); }
  if (url.includes("/rest/v1/variantes") && method === "GET") return ok([]);
  if (url.includes("/rest/v1/cupons") && method === "GET") return ok([]);
  if (url.includes("/rest/v1/pedidos") && method === "POST") { pedidoGravado = JSON.parse(opts.body); return ok({}, 201); }
  if (url.includes("infinitepay.io/links")) return ok({ url: "https://checkout.test/abc" });
  throw new Error("fetch não mockado: " + method + " " + url);
};

function mockRes() { return { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } }; }
function futuro(dias) { return new Date(Date.now() + dias * 86400000).toISOString(); }
function passado(dias) { return new Date(Date.now() - dias * 86400000).toISOString(); }

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); } }

const run = async () => {
  // 1) TOKEN válido em cache -> NÃO renova
  authRow = { access_token: "AT-cache", refresh_token: "RT-1", expires_at: futuro(20) };
  tokenCalls = [];
  const t1 = await tokenValido("test-key");
  check("1. token válido em cache é reutilizado (sem renovar)", t1 === "AT-cache" && tokenCalls.length === 0, { t1, tokenCalls });

  // 2) TOKEN perto de expirar -> renova via refresh_token e salva (inclusive RT novo)
  authRow = { access_token: "AT-old", refresh_token: "RT-1", expires_at: passado(1) };
  tokenCalls = []; savedAuth = null;
  const t2 = await tokenValido("test-key");
  check("2a. renova quando expirado", tokenCalls.length === 1 && tokenCalls[0].grant_type === "refresh_token", tokenCalls);
  check("2b. retorna o novo access_token", t2 === "AT-refresh_token", { t2 });
  check("2c. salva o refresh_token rotacionado", savedAuth && savedAuth.refresh_token === "RT-new", savedAuth);

  // 3) cotarFrete limpa as opções (remove serviço com erro; mapeia campos)
  authRow = { access_token: "AT-cache", refresh_token: "RT-1", expires_at: futuro(20) };
  const ops = await cotarFrete("test-key", "01001-000", [{ produto_id: 1, qtd: 2 }]);
  check("3a. remove serviço com erro (sobram 2)", ops.length === 2, ops);
  check("3b. mapeia preço como número (PAC 18.9)", ops.some((o) => o.servico === "PAC" && o.preco === 18.9), ops);
  check("3c. envia origem = LOJA_CEP_ORIGEM (só dígitos)", calcCalls.length && calcCalls[calcCalls.length - 1].from.postal_code === "68552000", calcCalls[calcCalls.length - 1]);

  // 4) endpoint /calcular-frete
  {
    const res = mockRes();
    await calcularFreteHandler({ method: "POST", headers: {}, body: { cep: "01001000", itens: [{ produto_id: 1, qtd: 1 }] } }, res);
    check("4a. calcular-frete OK retorna opções ordenadas (mais barata 1ª)", res._status === 200 && res._json.opcoes[0].preco === 18.9, res._json);
    const r2 = mockRes();
    await calcularFreteHandler({ method: "POST", headers: {}, body: { cep: "123", itens: [{ produto_id: 1, qtd: 1 }] } }, r2);
    check("4b. CEP inválido -> 400", r2._status === 400, r2._json);
    const r3 = mockRes();
    await calcularFreteHandler({ method: "POST", headers: {}, body: { cep: "01001000", itens: [] } }, r3);
    check("4c. carrinho vazio -> 400", r3._status === 400, r3._json);
  }

  // 5) criar-pagamento RECONFERE o frete (usa o preço do servidor, não do cliente)
  const cliente = { nome: "Maria", email: "m@x.com", tel: "94999", cep: "01001-000", end: "Rua 1" };
  {
    // cliente tenta forçar frete R$ 0 mandando preço — servidor ignora e cota SEDEX (32.50)
    const res = mockRes();
    await criarPagamento({ method: "POST", headers: {}, body: {
      itens: [{ produto_id: 1, qtd: 1 }],
      frete: { tipo: "melhorenvio", servico_id: 2, valor: 0, preco: 0 },
      cliente,
    } }, res);
    check("5a. usa o frete RECONFERIDO (SEDEX 32.50), ignora o do cliente", res._status === 200 && pedidoGravado.frete === 32.5, { status: res._status, frete: pedidoGravado && pedidoGravado.frete });
    check("5b. label do frete = transportadora + serviço", pedidoGravado && pedidoGravado.frete_tipo === "Correios SEDEX", pedidoGravado && pedidoGravado.frete_tipo);
    check("5c. total = produto(100) + frete(32.50)", pedidoGravado && pedidoGravado.total === 132.5, pedidoGravado && pedidoGravado.total);
  }

  // 6) serviço inexistente na cotação -> 400
  {
    const res = mockRes();
    await criarPagamento({ method: "POST", headers: {}, body: {
      itens: [{ produto_id: 1, qtd: 1 }],
      frete: { tipo: "melhorenvio", servico_id: 999 },
      cliente,
    } }, res);
    check("6. serviço escolhido não existe mais p/ o CEP -> 400", res._status === 400, res._json);
  }

  // 7) retirada na loja -> frete 0, sem cotar
  {
    const res = mockRes();
    await criarPagamento({ method: "POST", headers: {}, body: {
      itens: [{ produto_id: 1, qtd: 1 }],
      frete: { tipo: "retirada" },
      cliente,
    } }, res);
    check("7. retirada -> frete 0", res._status === 200 && pedidoGravado.frete === 0 && pedidoGravado.frete_tipo === "Retirar na loja", pedidoGravado && { f: pedidoGravado.frete, t: pedidoGravado.frete_tipo });
  }

  // 8) OAuth: troca de código por token (callback inicial)
  {
    tokenCalls = [];
    const tk = await trocarCodigoPorToken("CODE123");
    check("8a. authorization_code -> tokens", tk.access_token === "AT-authorization_code" && tk.refresh_token === "RT-new", tk);
    check("8b. envia grant_type=authorization_code + code", tokenCalls[0].grant_type === "authorization_code" && tokenCalls[0].code === "CODE123", tokenCalls[0]);
  }

  console.log("\n" + pass + " passaram, " + fail + " falharam.");
  if (fail > 0) process.exit(1);
};

run().catch((e) => { console.error("Erro no runner:", e); process.exit(1); });
