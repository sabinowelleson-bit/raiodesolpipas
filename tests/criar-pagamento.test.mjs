// tests/criar-pagamento.test.mjs
// Testes anti-fraude do endpoint /api/criar-pagamento.
// Mocka o fetch (Supabase + InfinitePay) e dirige o handler real com entradas
// maliciosas, provando que o servidor recalcula preço, respeita estoque, valida
// variante/cupom/frete e nunca deixa o total <= 0.
//
// Rodar:  node tests/criar-pagamento.test.mjs
//
// NÃO faz rede: tudo é mockado. Não precisa de SUPABASE_SERVICE_ROLE_KEY real.

import handler from "../api/criar-pagamento.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// ---- "Banco" de mentira ----
const PRODUTOS = [
  { id: 1, nome: "Pipa Azul", preco: 100, preco_promo: null, estoque: 5, ativo: true },
  { id: 2, nome: "Linha 10", preco: 50, preco_promo: null, estoque: 0, ativo: true },   // esgotado
  { id: 3, nome: "Item Velho", preco: 30, preco_promo: null, estoque: 9, ativo: false }, // inativo
  { id: 4, nome: "Carretilha", preco: 200, preco_promo: 150, estoque: null, ativo: true }, // sem estoque gerenciado
];
const VARIANTES = [
  { id: "va", produto_id: 1, cor: "Azul", tamanho: "M", preco: 120, preco_promo: null, estoque: 3, ativo: true },
  { id: "vb", produto_id: 1, cor: "Verde", tamanho: "G", preco: 120, preco_promo: null, estoque: 3, ativo: false }, // inativa
  { id: "vc", produto_id: 2, cor: "Vermelha", tamanho: "P", preco: 80, preco_promo: null, estoque: 10, ativo: true },
];
const CUPONS = [
  { id: 10, codigo: "PROMO10", tipo: "percentual", valor: 10, validade: null, ativo: true },
  { id: 11, codigo: "EXPIRADO", tipo: "percentual", valor: 50, validade: "2020-01-01", ativo: true },
  { id: 12, codigo: "FIXO100", tipo: "fixo", valor: 100, validade: null, ativo: true },
];

let pedidoGravado = null;

function parseInList(url) {
  const m = url.match(/id=in\.\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(",").filter(Boolean).map(decodeURIComponent);
}

global.fetch = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });

  if (url.includes("/rest/v1/produtos") && method === "GET") {
    const ids = parseInList(url).map((n) => parseInt(n, 10));
    return ok(PRODUTOS.filter((p) => ids.includes(p.id)));
  }
  if (url.includes("/rest/v1/variantes") && method === "GET") {
    const ids = parseInList(url);
    return ok(VARIANTES.filter((v) => ids.includes(String(v.id))));
  }
  if (url.includes("/rest/v1/cupons") && method === "GET") {
    const m = url.match(/codigo=eq\.([^&]+)/);
    const cod = m ? decodeURIComponent(m[1]) : "";
    return ok(CUPONS.filter((c) => c.codigo === cod && c.ativo === true));
  }
  if (url.includes("/rest/v1/pedidos") && method === "POST") {
    pedidoGravado = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({}), text: async () => "" };
  }
  if (url.includes("infinitepay.io/links")) {
    return ok({ url: "https://checkout.test/abc" });
  }
  throw new Error("fetch não mockado: " + method + " " + url);
};

// ---- mock req/res ----
function mockRes() {
  return {
    _status: 200,
    _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}
const clienteOk = { nome: "Maria", email: "m@x.com", tel: "9499", cep: "68000", end: "Rua 1" };
async function call(body, headers = {}) {
  pedidoGravado = null;
  const res = mockRes();
  await handler({ method: "POST", headers, body }, res);
  return { status: res._status, json: res._json, pedido: pedidoGravado };
}

// ---- mini framework ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

const run = async () => {
  // 1) PREÇO FORJADO — servidor ignora o preco do cliente e usa o do banco.
  {
    const r = await call({ itens: [{ produto_id: 1, qtd: 1, preco: 1, nome: "HACK" }], frete_tipo: "pac", cliente: clienteOk });
    check("1. preço forjado ignorado (subtotal=100, não 1)", r.status === 200 && r.pedido && r.pedido.subtotal === 100, r.pedido);
    check("1b. total = 100 + 18.90 frete", r.pedido && r.pedido.total === 118.9, r.pedido);
  }

  // 2) QUANTIDADE ABUSIVA
  {
    const neg = await call({ itens: [{ produto_id: 1, qtd: -3 }], frete_tipo: "retirada", cliente: clienteOk });
    check("2a. qtd negativa -> vira 1", neg.status === 200 && neg.pedido.itens[0].qtd === 1, neg.pedido && neg.pedido.itens[0]);
    const frac = await call({ itens: [{ produto_id: 1, qtd: 2.7 }], frete_tipo: "retirada", cliente: clienteOk });
    check("2b. qtd fracionária 2.7 -> 2 (floor)", frac.status === 200 && frac.pedido.itens[0].qtd === 2, frac.pedido && frac.pedido.itens[0]);
    const big = await call({ itens: [{ produto_id: 1, qtd: 9999 }], frete_tipo: "retirada", cliente: clienteOk });
    check("2c. qtd > estoque(5) -> 409 rejeitado", big.status === 409, big);
  }

  // 3) ESTOQUE — produto esgotado (estoque=0) rejeitado.
  {
    const r = await call({ itens: [{ produto_id: 2, qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("3. produto esgotado (estoque=0) -> 409", r.status === 409, r);
  }

  // 4) INTEGRIDADE DA VARIANTE
  {
    const mism = await call({ itens: [{ produto_id: 1, variante_id: "vc", qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("4a. variante de outro produto -> 400", mism.status === 400, mism);
    const inativa = await call({ itens: [{ produto_id: 1, variante_id: "vb", qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("4b. variante ativo=false -> 400", inativa.status === 400, inativa);
    const okVar = await call({ itens: [{ produto_id: 1, variante_id: "va", qtd: 1 }], frete_tipo: "retirada", cliente: clienteOk });
    check("4c. variante válida usa preço da variante (120)", okVar.status === 200 && okVar.pedido.subtotal === 120, okVar.pedido);
  }

  // 4d) PRODUTO INATIVO rejeitado
  {
    const r = await call({ itens: [{ produto_id: 3, qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("4d. produto ativo=false -> 400", r.status === 400, r);
  }

  // 5) CUPONS
  {
    const exp = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "pac", cupom: "EXPIRADO", cliente: clienteOk });
    check("5a. cupom expirado -> desconto 0", exp.status === 200 && exp.pedido.desconto === 0, exp.pedido);
    const inexist = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "pac", cupom: "NAOEXISTE", cliente: clienteOk });
    check("5b. cupom inexistente -> desconto 0", inexist.status === 200 && inexist.pedido.desconto === 0, inexist.pedido);
    const ok10 = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "retirada", cupom: "promo10", cliente: clienteOk });
    check("5c. cupom 10% (case-insensitive) -> desconto 10", ok10.status === 200 && ok10.pedido.desconto === 10, ok10.pedido);
    // total zerado: subtotal 100, frete retirada 0, cupom fixo 100 -> total 0 -> rejeita
    const zero = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "retirada", cupom: "FIXO100", cliente: clienteOk });
    check("5d. cupom que zera o total -> 400 (total > 0 garantido)", zero.status === 400, zero);
  }

  // 6) FRETE inválido
  {
    const r = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "aereo", cliente: clienteOk });
    check("6. frete inválido -> 400", r.status === 400, r);
  }

  // 8) ENTRADAS QUEBRADAS
  {
    const vazio = await call({ itens: [], frete_tipo: "pac", cliente: clienteOk });
    check("8a. carrinho vazio -> 400", vazio.status === 400, vazio);
    const idRuim = await call({ itens: [{ produto_id: "abc", qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("8b. id não numérico -> 400", idRuim.status === 400, idRuim);
    const semCliente = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "pac", cliente: { nome: "X" } });
    check("8c. dados de cliente incompletos -> 400", semCliente.status === 400, semCliente);
    const inexistente = await call({ itens: [{ produto_id: 999, qtd: 1 }], frete_tipo: "pac", cliente: clienteOk });
    check("8d. produto inexistente -> 400", inexistente.status === 400, inexistente);
  }

  // 9) ORIGEM
  {
    const bad = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "pac", cliente: clienteOk }, { origin: "https://evil.com" });
    check("9a. Origin não autorizado -> 403", bad.status === 403, bad);
    const good = await call({ itens: [{ produto_id: 1, qtd: 1 }], frete_tipo: "pac", cliente: clienteOk }, { origin: "https://www.raiodesolpipas.com.br" });
    check("9b. Origin do site -> 200", good.status === 200, good);
  }

  console.log("\n" + pass + " passaram, " + fail + " falharam.");
  if (fail > 0) process.exit(1);
};

run().catch((e) => { console.error("Erro no runner:", e); process.exit(1); });
