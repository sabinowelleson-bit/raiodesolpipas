// ===================================================================
// app.js — Raio de Sol Pipas
// Produtos no Supabase (banco + storage). Todo visitante vê os mesmos.
// ===================================================================

// ---------- CONFIG SUPABASE ----------
const SUPABASE_URL = 'https://kscqoczfdtoanjdoidtl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtzY3FvY3pmZHRvYW5qZG9pZHRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMTQ3NjIsImV4cCI6MjA5NjY5MDc2Mn0.xI0Y2tNGls4Rj_jpbvixadWCb6asFU0jAyDL4G_TSDA';

// WhatsApp da loja (formato internacional, sem + nem espaços)
const WHATSAPP = '5594984361103';

// Cria o cliente Supabase (a lib vem do <script> no HTML)
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expõe como _supabase para o script de auth do admin
window._supabase = sb;

// ---------- Helpers ----------
function formatarPreco(valor) {
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function linkWhatsApp(produto) {
  const texto = 'Olá! Vi o site e quero ' + produto.nome + ' (' + formatarPreco(produto.preco_promo || produto.preco) + '). Pode me passar as formas de pagamento?';
  return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(texto);
}

// ---------- Funções de dados (Supabase) ----------
async function getProdutos({ somenteAtivos = true, somenteDestaques = false } = {}) {
  let query = sb.from('produtos').select('*').order('created_at', { ascending: false });
  if (somenteAtivos)    query = query.eq('ativo', true);
  if (somenteDestaques) query = query.eq('destaque', true).limit(4);
  const { data, error } = await query;
  if (error) { console.error('Erro ao buscar produtos:', error); return []; }
  return data || [];
}

async function removerProduto(id) {
  const { data: prod } = await sb.from('produtos').select('imagem_url').eq('id', id).single();
  if (prod && prod.imagem_url) {
    const caminho = prod.imagem_url.split('/produtos/')[1];
    if (caminho) await sb.storage.from('produtos').remove([caminho]);
  }
  const { error } = await sb.from('produtos').delete().eq('id', id);
  if (error) { alert('Erro ao excluir. Você está logado?'); console.error(error); return false; }
  return true;
}

async function uploadFoto(arquivo) {
  const ext = arquivo.name.split('.').pop();
  const nome = Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
  const { error } = await sb.storage.from('produtos').upload(nome, arquivo, {
    cacheControl: '3600',
    upsert: false
  });
  if (error) { console.error('Erro upload:', error); throw error; }
  const { data } = sb.storage.from('produtos').getPublicUrl(nome);
  return data.publicUrl;
}

async function adicionarProduto(produto, arquivoFoto) {
  let imagem_url = null;
  if (arquivoFoto) imagem_url = await uploadFoto(arquivoFoto);
  const { error } = await sb.from('produtos').insert([Object.assign({}, produto, { imagem_url: imagem_url })]);
  if (error) { console.error('Erro ao salvar:', error); throw error; }
}

// ===================================================================
// LÓGICA DO ADMIN  (roda só se existir o formulário do admin)
// ===================================================================
function initAdmin() {
  const form = document.getElementById('rs-form-produto');
  if (!form) return;

  // ---------- VERIFICAÇÃO DE SESSÃO ----------
  const loginOverlay = document.getElementById('login-overlay');
  if (loginOverlay) {
    sb.auth.getSession().then(function({ data }) {
      if (data && data.session) {
        loginOverlay.classList.add('hidden');
        const nameEl = document.querySelector('.sidebar-user .name');
        if (nameEl && data.session.user) {
          nameEl.textContent = data.session.user.email.split('@')[0];
        }
      }
    });
  }
  // -------------------------------------------

  const tabela = document.getElementById('rs-tabela-produtos');
  const inputArquivo = document.getElementById('rs-imagem-arquivo');
  const preview = document.getElementById('rs-preview');
  let arquivoSelecionado = null;

  async function renderTabelaAdmin() {
    const lista = await getProdutos({ somenteAtivos: false });
    if (!tabela) return;
    if (lista.length === 0) {
      tabela.innerHTML =
        '<tr><td colspan="5" style="padding:24px;text-align:center;color:#64748B">Nenhum produto cadastrado ainda.</td></tr>';
      return;
    }
    tabela.innerHTML = lista.map(function(p) {
      return '<tr>' +
        '<td><strong>' + p.nome + '</strong><br/>' +
        '<span style="font-size:11px;color:#64748B">' + (p.categoria || '—') + '</span></td>' +
        '<td>' + formatarPreco(p.preco) + '</td>' +
        '<td>' + (p.estoque != null ? p.estoque : '—') + '</td>' +
        '<td style="text-align:center">' + (p.destaque ? '⭐ Sim' : '—') + '</td>' +
        '<td style="text-align:right">' +
          '<button class="icon-action danger" onclick="excluirProdutoAdmin(' + p.id + ')" title="Excluir">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<polyline points="3 6 5 6 21 6"/>' +
              '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
            '</svg>' +
          '</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  window.excluirProdutoAdmin = async function (id) {
    if (confirm('Excluir este produto?')) {
      const ok = await removerProduto(id);
      if (ok) renderTabelaAdmin();
    }
  };

  // Preview da foto escolhida
  if (inputArquivo) {
    inputArquivo.addEventListener('change', function () {
      const arquivo = inputArquivo.files[0];
      if (!arquivo) return;
      if (arquivo.size > 5 * 1024 * 1024) {
        alert('Essa foto é muito grande. Escolha uma imagem de até 5MB.');
        inputArquivo.value = '';
        return;
      }
      arquivoSelecionado = arquivo;
      const leitor = new FileReader();
      leitor.onload = function (e) {
        if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
      };
      leitor.readAsDataURL(arquivo);
    });
  }

  // Submissão do formulário
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const checkDestaque = document.getElementById('rs-destaque');
    const produto = {
      nome:      document.getElementById('rs-nome').value.trim(),
      preco:     parseFloat(document.getElementById('rs-preco').value) || 0,
      categoria: document.getElementById('rs-categoria').value.trim(),
      estoque:   parseInt(document.getElementById('rs-estoque').value) || 0,
      descricao: document.getElementById('rs-descricao').value.trim(),
      destaque:  checkDestaque ? checkDestaque.checked : false
    };
    if (!produto.nome) { alert('Informe o nome do produto.'); return; }

    const textoBtn = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
    try {
      await adicionarProduto(produto, arquivoSelecionado);
      form.reset();
      arquivoSelecionado = null;
      if (preview) preview.style.display = 'none';
      await renderTabelaAdmin();
      alert('Produto cadastrado com sucesso!');
    } catch (err) {
      alert('Não foi possível salvar. Verifique se você está logado e tente novamente.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = textoBtn; }
    }
  });

  renderTabelaAdmin();
}

// ===================================================================
// LÓGICA DO SITE
// ===================================================================

// Gera o HTML de um product-card (mesmo estilo visual do site)
function gerarCardHTML(p) {
  var temPromo = p.preco_promo && p.preco_promo < p.preco;
  var precoAtual = temPromo ? p.preco_promo : p.preco;
  var parcela = precoAtual / 12;
  var foto = p.imagem_url || 'https://via.placeholder.com/400x400?text=Raio+de+Sol+Pipas';

  return '<article class="product-card">' +
    '<div class="product-media">' +
      (p.badge ? '<div class="product-badges"><span class="pill rank gold">' + p.badge + '</span></div>' : '') +
      '<img class="product-photo" src="' + foto + '" alt="' + p.nome + '" loading="lazy"/>' +
    '</div>' +
    '<div class="product-info">' +
      '<span class="product-cat">' + (p.categoria || 'Produto') + '</span>' +
      '<h3 class="product-name">' + p.nome + '</h3>' +
      '<span class="product-stock">' + (p.estoque > 0 ? p.estoque + ' unidades' : 'Sob consulta') + '</span>' +
      '<div class="product-price">' +
        '<span class="current">' + formatarPreco(precoAtual) + '</span>' +
        (temPromo ? '<span class="original">' + formatarPreco(p.preco) + '</span>' : '') +
        '<span class="installment">ou 12x ' + formatarPreco(parcela) + ' sem juros</span>' +
      '</div>' +
      '<a class="product-cta" href="' + linkWhatsApp(p) + '" target="_blank" rel="noopener" ' +
        'style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;">' +
        'Comprar pelo WhatsApp ' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
          '<path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.51 5.26l-.999 3.648 3.978-1.607z"/>' +
        '</svg>' +
      '</a>' +
    '</div>' +
  '</article>';
}

async function initSite() {
  // --- TOP 4 DESTAQUES (seção "Os mais vendidos") ---
  var containerDestaques = document.getElementById('rs-lista-produtos');
  if (containerDestaques) {
    var destaques = await getProdutos({ somenteAtivos: true, somenteDestaques: true });
    if (destaques.length === 0) {
      containerDestaques.innerHTML =
        '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#64748B">Em breve nossos destaques aqui!</p>';
    } else {
      containerDestaques.innerHTML = destaques.map(gerarCardHTML).join('');
    }
  }

  // --- CATÁLOGO COMPLETO (se existir o container rs-catalogo) ---
  var containerCatalogo = document.getElementById('rs-catalogo');
  if (containerCatalogo) {
    var todos = await getProdutos({ somenteAtivos: true });
    if (todos.length === 0) {
      containerCatalogo.innerHTML =
        '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#64748B">Catálogo em atualização. Volte em breve!</p>';
    } else {
      containerCatalogo.innerHTML = todos.map(gerarCardHTML).join('');
    }
  }
}

// ---------- Inicialização ----------
document.addEventListener('DOMContentLoaded', function () {
  initAdmin();
  initSite();
});
