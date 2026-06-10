// ===================================================================
// app.js — Raio de Sol Pipas
// Gerencia produtos via localStorage (compartilhado entre admin e site)
// ===================================================================

const STORAGE_KEY = 'raioDeSol_produtos';

// ---------- Funções de dados ----------
function getProdutos() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function salvarProdutos(lista) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
}

function adicionarProduto(produto) {
  const lista = getProdutos();
  produto.id = Date.now(); // id único simples
  lista.push(produto);
  salvarProdutos(lista);
  return produto;
}

function removerProduto(id) {
  const lista = getProdutos().filter(p => p.id !== id);
  salvarProdutos(lista);
}

function formatarPreco(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

// ===================================================================
// LÓGICA DO ADMIN  (roda só se existir o formulário do admin)
// ===================================================================
function initAdmin() {
  const form = document.getElementById('rs-form-produto');
  if (!form) return; // não está no admin

  const tabela = document.getElementById('rs-tabela-produtos');

  function renderTabelaAdmin() {
    const lista = getProdutos();
    if (!tabela) return;

    if (lista.length === 0) {
      tabela.innerHTML =
        '<tr><td colspan="4" style="padding:24px;text-align:center;color:#64748B">Nenhum produto cadastrado ainda.</td></tr>';
      return;
    }

    tabela.innerHTML = lista.map(p => `
      <tr>
        <td>
          <strong>${p.nome}</strong><br/>
          <span style="font-size:11px;color:#64748B">${p.categoria || '—'}</span>
        </td>
        <td>${formatarPreco(p.preco)}</td>
        <td>${p.estoque ?? '—'}</td>
        <td style="text-align:right">
          <button class="icon-action danger" onclick="excluirProdutoAdmin(${p.id})" title="Excluir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </td>
      </tr>
    `).join('');
  }

  // Exclusão (global para o onclick funcionar)
  window.excluirProdutoAdmin = function (id) {
    if (confirm('Excluir este produto?')) {
      removerProduto(id);
      renderTabelaAdmin();
    }
  };

  // Submissão do formulário
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    const produto = {
      nome: document.getElementById('rs-nome').value.trim(),
      preco: parseFloat(document.getElementById('rs-preco').value) || 0,
      categoria: document.getElementById('rs-categoria').value.trim(),
      estoque: parseInt(document.getElementById('rs-estoque').value) || 0,
      imagem: document.getElementById('rs-imagem').value.trim(),
      descricao: document.getElementById('rs-descricao').value.trim()
    };

    if (!produto.nome) {
      alert('Informe o nome do produto.');
      return;
    }

    adicionarProduto(produto);
    form.reset();
    renderTabelaAdmin();
    alert('Produto cadastrado com sucesso!');
  });

  renderTabelaAdmin();
}

// ===================================================================
// LÓGICA DO SITE  (roda só se existir o container de produtos)
// ===================================================================
function initSite() {
  const container = document.getElementById('rs-lista-produtos');
  if (!container) return; // não está no site

  const lista = getProdutos();

  if (lista.length === 0) {
    container.innerHTML =
      '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#64748B">Nenhum produto disponível no momento.</p>';
    return;
  }

  container.innerHTML = lista.map(p => `
    <article class="rs-card-produto">
      <img src="${p.imagem || 'https://via.placeholder.com/300x300?text=Pipa'}"
           alt="${p.nome}" loading="lazy"/>
      <div class="rs-card-corpo">
        <h3>${p.nome}</h3>
        <p class="rs-cat">${p.categoria || ''}</p>
        <p class="rs-desc">${p.descricao || ''}</p>
        <strong class="rs-preco">${formatarPreco(p.preco)}</strong>
      </div>
    </article>
  `).join('');
}

// ---------- Inicialização ----------
document.addEventListener('DOMContentLoaded', function () {
  initAdmin();
  initSite();
});
