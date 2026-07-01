/* =========================================================================
   carrinho.js — Carrinho de compras (Raio de Sol Pipas)
   Estado guardado em localStorage. Usado por produto.html (adicionar)
   e por carrinho_raio_de_sol.html (listar, alterar, remover, somar).

   CONTRATO DO ITEM (todas as páginas devem usar estes nomes):
     {
       produto_id,    // bigint do produto (number ou string)
       variante_id,   // uuid da variante (string) ou null se o produto não tem variantes
       nome,          // nome do produto (pra exibir no carrinho)
       categoria,     // texto (ex.: "Pipa") — vazio se não aplica
       cor,           // texto (ex.: "Azul") — vazio se não aplica
       tamanho,       // texto (ex.: "45cm") — vazio se não aplica
       preco,         // number — preço unitário JÁ resolvido (promo ou normal)
       qtd,           // number — quantidade
       foto,          // url da imagem
       estoque        // number|null — null = não controla (sem teto); 0 = esgotado; >0 = teto de quantidade
     }

   A "identidade" de um item é produto_id + variante_id. Adicionar o mesmo
   produto+variante de novo soma a quantidade, não cria linha duplicada.
   ========================================================================= */

window.Carrinho = (() => {
  const CHAVE = 'rs_carrinho';

  // --- leitura / escrita -------------------------------------------------
  function ler() {
    try {
      const dados = localStorage.getItem(CHAVE);
      const itens = dados ? JSON.parse(dados) : [];
      return Array.isArray(itens) ? itens : [];
    } catch (e) {
      console.error('[carrinho] erro ao ler:', e);
      return [];
    }
  }

  function salvar(itens) {
    try {
      localStorage.setItem(CHAVE, JSON.stringify(itens));
    } catch (e) {
      console.error('[carrinho] erro ao salvar:', e);
    }
    atualizarBadge();
    // avisa a página (ex.: o carrinho_raio_de_sol.html pode re-renderizar)
    window.dispatchEvent(new CustomEvent('carrinho:atualizado', { detail: { itens } }));
  }

  // identidade do item = produto + variante
  function chaveItem(item) {
    return `${item.produto_id}::${item.variante_id || 'sem-variante'}`;
  }

  function mesmaIdentidade(item, produto_id, variante_id) {
    return item.produto_id == produto_id &&
           (item.variante_id || null) == (variante_id || null);
  }

  // --- operações ---------------------------------------------------------
  function adicionar(novo) {
    if (!novo || novo.produto_id == null) {
      console.warn('[carrinho] adicionar() recebeu item inválido:', novo);
      return ler();
    }

    const itens   = ler();
    // Estoque: null = não controla (sem teto); 0 = esgotado; >0 = teto nesse número.
    const estoque = (novo.estoque == null || isNaN(Number(novo.estoque))) ? null : Number(novo.estoque);
    const qtdAdd  = Math.max(1, Number(novo.qtd) || 1);
    const existente = itens.find(i => mesmaIdentidade(i, novo.produto_id, novo.variante_id));

    if (existente) {
      let novaQtd = existente.qtd + qtdAdd;
      if (estoque != null) novaQtd = Math.min(novaQtd, estoque);
      existente.qtd = novaQtd;
      // mantém preço/estoque sempre atualizados com o último valor enviado
      existente.preco   = Number(novo.preco) || existente.preco;
      existente.estoque = estoque;
    } else {
      itens.push({
        produto_id:  novo.produto_id,
        variante_id: novo.variante_id || null,
        nome:        novo.nome || '',
        categoria:   novo.categoria || '',
        cor:         novo.cor || '',
        tamanho:     novo.tamanho || '',
        preco:       Number(novo.preco) || 0,
        qtd:         estoque != null ? Math.min(qtdAdd, estoque) : qtdAdd,
        foto:        novo.foto || '',
        estoque:     estoque
      });
    }

    salvar(itens);
    return ler();
  }

  function atualizarQtd(produto_id, variante_id, novaQtd) {
    const itens = ler();
    const item  = itens.find(i => mesmaIdentidade(i, produto_id, variante_id));
    if (!item) return ler();

    novaQtd = Number(novaQtd);
    if (!novaQtd || novaQtd <= 0) {
      return remover(produto_id, variante_id);
    }
    if (item.estoque != null) novaQtd = Math.min(novaQtd, item.estoque);
    item.qtd = novaQtd;

    salvar(itens);
    return ler();
  }

  // soma/subtrai 1 (atalho pros botões + / - do carrinho)
  function mudarQtd(produto_id, variante_id, delta) {
    const item = ler().find(i => mesmaIdentidade(i, produto_id, variante_id));
    if (!item) return ler();
    return atualizarQtd(produto_id, variante_id, item.qtd + Number(delta));
  }

  function remover(produto_id, variante_id) {
    const itens = ler().filter(i => !mesmaIdentidade(i, produto_id, variante_id));
    salvar(itens);
    return itens;
  }

  function limpar() {
    salvar([]);
  }

  // --- totais ------------------------------------------------------------
  function subtotal() {
    return ler().reduce((s, i) => s + (Number(i.preco) * Number(i.qtd)), 0);
  }

  function totalItens() {
    return ler().reduce((s, i) => s + Number(i.qtd), 0);
  }

  function vazio() {
    return ler().length === 0;
  }

  // --- badge do ícone do carrinho ---------------------------------------
  // Marque o elemento do contador no header com data-carrinho-badge.
  // Ex.: <span data-carrinho-badge>0</span>
  function atualizarBadge() {
    const n = totalItens();
    document.querySelectorAll('[data-carrinho-badge]').forEach(el => {
      el.textContent = n;
      el.style.display = n > 0 ? '' : 'none';
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', atualizarBadge);
  }

  // --- API pública -------------------------------------------------------
  return {
    ler,
    adicionar,
    atualizarQtd,
    mudarQtd,
    remover,
    limpar,
    subtotal,
    totalItens,
    vazio,
    atualizarBadge,
    chaveItem
  };
})();
