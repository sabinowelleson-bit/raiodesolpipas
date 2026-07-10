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

// Escapa texto antes de injetar via innerHTML (proteção XSS). Os dados de
// produto vêm do admin, mas escapamos por segurança e p/ não quebrar com < & ".
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
// Placeholder local (sem depender de serviço externo) p/ produto sem foto.
var SEM_FOTO = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='600'%20height='600'%3E%3Crect%20width='600'%20height='600'%20fill='%23F0F7FF'/%3E%3Ctext%20x='300'%20y='312'%20font-family='Arial,sans-serif'%20font-size='32'%20fill='%238AA0BC'%20text-anchor='middle'%3EFoto%20em%20breve%3C/text%3E%3C/svg%3E";

function linkWhatsApp(produto) {
  const texto = 'Olá! Vi o site e quero ' + produto.nome + ' (' + formatarPreco(produto.preco_promo || produto.preco) + '). Pode me passar as formas de pagamento?';
  return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(texto);
}

// ---------- Funções de dados (Supabase) ----------
async function getProdutos({ somenteAtivos = true, somenteDestaques = false } = {}) {
  // 1) Busca os produtos
  let query = sb.from('produtos').select('*').order('created_at', { ascending: false });
  if (somenteAtivos)    query = query.eq('ativo', true);
  if (somenteDestaques) query = query.eq('destaque', true).limit(4);
  const { data, error } = await query;
  if (error) { console.error('Erro ao buscar produtos:', error); return []; }
  const produtos = data || [];

  // 2) Busca todas as variantes e agrupa por produto_id (query separada = mais confiável que join)
  const respVar = await sb.from('variantes').select('*');
  const porProduto = {};
  if (!respVar.error && respVar.data) {
    respVar.data.forEach(function (v) {
      if (!porProduto[v.produto_id]) porProduto[v.produto_id] = [];
      porProduto[v.produto_id].push(v);
    });
  }

  // 3) Anexa as variantes a cada produto
  produtos.forEach(function (p) { p.variantes = porProduto[p.id] || []; });
  return produtos;
}

// Helpers de variação: a partir das variantes de um produto, descobre
// o menor preço (pra exibir "a partir de") e o estoque total.
function precoExibicao(p) {
  const vars = (p.variantes || []).filter(function (v) { return v.ativo !== false; });
  if (vars.length > 0) {
    const precos = vars.map(function (v) { return v.preco_promo || v.preco; }).filter(function (n) { return n > 0; });
    if (precos.length > 0) return Math.min.apply(null, precos);
  }
  return p.preco_promo || p.preco || 0;
}
function estoqueTotal(p) {
  const vars = (p.variantes || []).filter(function (v) { return v.ativo !== false; });
  if (vars.length > 0) {
    // Semântica null/0/>0 por variante (nunca Number(x)||0, que colapsa null→0):
    // se QUALQUER variante ativa não controla (estoque==null) => produto não controla (null).
    // Senão soma os números (0 => "Esgotado"; >0 => a soma).
    let soma = 0;
    for (const v of vars) {
      if (v.estoque == null) return null;
      soma += Number(v.estoque) || 0;
    }
    return soma;
  }
  return p.estoque != null ? p.estoque : null;
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

// Cria (insert) OU edita (update) um produto. Se editId vier, ATUALIZA só os dados do
// produto (nome/preço/categoria/estoque/descrição/destaque/imagem) — as VARIANTES NÃO são
// tocadas na edição (isso é a Fase 3). imagemAtual = URL já salva, mantida quando o dono
// não sobe uma foto nova.
async function adicionarProduto(produto, arquivoFoto, variantes, editId, imagemAtual) {
  // Imagem: foto nova -> upload; senão, na edição mantém a atual; na criação fica sem foto.
  let imagem_url = editId ? (imagemAtual || null) : null;
  if (arquivoFoto) imagem_url = await uploadFoto(arquivoFoto);

  // ---- EDIÇÃO: update do MESMO id (não duplica; não mexe em variantes) ----
  if (editId) {
    const patch = Object.assign({}, produto, { imagem_url: imagem_url });
    const { error } = await sb.from('produtos').update(patch).eq('id', editId);
    if (error) { console.error('Erro ao atualizar produto:', error); throw error; }
    // Devolve os campos salvos p/ a tabela atualizar do cache (sem re-buscar no servidor).
    return patch;
  }

  // ---- CRIAÇÃO (inalterada): insert + variantes ----
  // 1) Cria o produto e RECUPERA o registro criado (precisamos do id pra ligar as variantes)
  const { data: criado, error } = await sb
    .from('produtos')
    .insert([Object.assign({}, produto, { imagem_url: imagem_url })])
    .select()
    .single();
  if (error) { console.error('Erro ao salvar produto:', error); throw error; }

  // 2) Se vieram variantes, salva cada uma ligada ao produto recém-criado
  if (variantes && variantes.length > 0) {
    const linhas = variantes.map(function (v) {
      return {
        produto_id: criado.id,
        cor:        v.cor || null,
        tamanho:    v.tamanho || null,
        preco:      v.preco || 0,
        estoque:    v.estoque || 0,
        ativo:      true
      };
    });
    const { error: errVar } = await sb.from('variantes').insert(linhas);
    if (errVar) {
      console.error('Erro ao salvar variações:', errVar);
      // O produto foi criado, mas as variantes falharam — avisa de forma clara
      throw new Error('O produto foi salvo, mas houve erro ao salvar as variações. Verifique e tente editar.');
    }
  }
  // Devolve o produto criado (com variantes já anexadas) p/ a tabela atualizar do cache.
  return Object.assign({ variantes: variantes && variantes.length ? variantes : [] }, criado);
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
    // Ativa o painel quando há sessão: esconde o overlay, mostra o nome e
    // carrega os DADOS REAIS (pedidos/KPIs) uma única vez. Sem o carregamento
    // automático, o admin fica mostrando o HTML estático/mock até clicar no menu.
    let painelCarregado = false;
    function ativarPainel(session) {
      if (!session) return;
      loginOverlay.classList.add('hidden');
      const nameEl = document.querySelector('.sidebar-user .name');
      if (nameEl && session.user) {
        nameEl.textContent = session.user.email.split('@')[0];
      }
      if (painelCarregado) return;            // dados reais: só uma vez por abertura
      painelCarregado = true;
      (function carregaQuandoPronto(tentativas) {
        if (typeof window.carregarPedidos === 'function') { window.carregarPedidos(); return; }
        if (tentativas > 0) setTimeout(function() { carregaQuandoPronto(tentativas - 1); }, 150);
      })(20);
    }

    // 1) Tentativa imediata: sessão já em cache no load/refresh.
    sb.auth.getSession().then(function({ data }) {
      if (data && data.session) ativarPainel(data.session);
    });

    // 2) Rede de segurança: o Supabase emite INITIAL_SESSION quando termina de
    //    restaurar a sessão no carregamento da página (caso o getSession() acima
    //    resolva antes disso). O login (SIGNED_IN) continua tratado no script do
    //    admin, então aqui só reagimos à restauração inicial — sem carga dupla.
    sb.auth.onAuthStateChange(function(event, session) {
      if (event === 'INITIAL_SESSION' && session) ativarPainel(session);
    });
  }
  // -------------------------------------------

  const tabela = document.getElementById('rs-tabela-produtos');
  const inputArquivo = document.getElementById('rs-imagem-arquivo');
  const preview = document.getElementById('rs-preview');
  let arquivoSelecionado = null;
  let produtosCache = []; // guarda os produtos renderizados p/ o "Editar" achar por id

  // Busca no servidor + renderiza (usado no load inicial).
  async function renderTabelaAdmin() {
    produtosCache = await getProdutos({ somenteAtivos: false });
    renderTabelaFromCache();
  }

  // Renderiza SÓ a partir do cache local (sem ida ao servidor) — usado após salvar,
  // pra não pagar um round-trip de rede a cada gravação.
  function renderTabelaFromCache() {
    if (!tabela) return;
    if (produtosCache.length === 0) {
      tabela.innerHTML =
        '<tr><td colspan="5" style="padding:24px;text-align:center;color:#64748B">Nenhum produto cadastrado ainda.</td></tr>';
      return;
    }
    tabela.innerHTML = produtosCache.map(function(p) {
      var nVars = (p.variantes || []).length;
      var precoTxt = (nVars > 0 ? 'A partir de ' : '') + formatarPreco(precoExibicao(p));
      var est = estoqueTotal(p);
      var estTxt = (est != null ? est : '—') + (nVars > 0 ? ' <span style="font-size:10px;color:#64748B">(' + nVars + ' var.)</span>' : '');
      return '<tr>' +
        '<td><strong>' + esc(p.nome) + '</strong><br/>' +
        '<span style="font-size:11px;color:#64748B">' + esc(p.categoria || '—') + '</span></td>' +
        '<td>' + precoTxt + '</td>' +
        '<td>' + estTxt + '</td>' +
        '<td style="text-align:center">' + (p.destaque ? '⭐ Sim' : '—') + '</td>' +
        '<td style="text-align:right">' +
          '<button class="icon-action" onclick="rsEditarProduto(' + p.id + ')" title="Editar" style="margin-right:6px">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
              '<path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' +
            '</svg>' +
          '</button>' +
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

  // Carrega um produto existente no formulário para EDITAR (só os dados do produto —
  // as variantes NÃO são editadas aqui; isso é a Fase 3). Espelha o rsCupomEditar.
  window.rsEditarProduto = function (id) {
    const p = produtosCache.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p) return;
    // Estado de edição no HIDDEN do form (não numa var global) — sobrevive a re-render e
    // some junto com o form no reset; evita salvar como "novo" e duplicar.
    const editHidden = document.getElementById('rs-edit-id'); if (editHidden) editHidden.value = p.id;

    document.getElementById('rs-nome').value = p.nome || '';
    document.getElementById('rs-preco').value = (p.preco != null ? p.preco : '');
    document.getElementById('rs-categoria').value = p.categoria || '';
    // Estoque: null = NÃO controla -> campo VAZIO; número (inclusive 0) -> o valor.
    document.getElementById('rs-estoque').value = (p.estoque == null ? '' : p.estoque);
    document.getElementById('rs-descricao').value = p.descricao || '';
    const chk = document.getElementById('rs-destaque'); if (chk) chk.checked = !!p.destaque;

    // Imagem atual guardada no hidden -> mantida se o dono não trocar a foto.
    const imgHidden = document.getElementById('rs-imagem'); if (imgHidden) imgHidden.value = p.imagem_url || '';
    if (preview) {
      if (p.imagem_url) { preview.src = p.imagem_url; preview.style.display = 'block'; }
      else { preview.src = ''; preview.style.display = 'none'; }
    }
    arquivoSelecionado = null;
    if (inputArquivo) inputArquivo.value = '';

    // Sinaliza modo edição no botão (e o texto volta ao padrão ao salvar/limpar).
    const bs = form.querySelector('[type="submit"]'); if (bs) bs.textContent = 'Salvar alterações';

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const nomeEl = document.getElementById('rs-nome'); if (nomeEl) nomeEl.focus();
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

  // Texto padrão do botão (pra restaurar ao sair do modo edição)
  const btnLabelPadrao = (function () { const b = form.querySelector('[type="submit"]'); return b ? b.textContent : 'Salvar produto'; })();

  // Lê o id de edição do HIDDEN do form (fonte da verdade — não de var global).
  function lerEditId() { const e = document.getElementById('rs-edit-id'); return (e && e.value) ? e.value : null; }
  function limparEditId() { const e = document.getElementById('rs-edit-id'); if (e) e.value = ''; }

  // Submissão do formulário — CRIA (insert) ou EDITA (update) conforme o hidden rs-edit-id
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const checkDestaque = document.getElementById('rs-destaque');
    // Estoque: campo VAZIO = não controla (null); "0" = esgotado; >0 = teto. (semântica null/0/>0)
    const estoqueRaw = document.getElementById('rs-estoque').value.trim();
    const produto = {
      nome:      document.getElementById('rs-nome').value.trim(),
      preco:     parseFloat(document.getElementById('rs-preco').value) || 0,
      categoria: document.getElementById('rs-categoria').value.trim(),
      estoque:   estoqueRaw === '' ? null : (parseInt(estoqueRaw, 10) || 0),
      descricao: document.getElementById('rs-descricao').value.trim(),
      destaque:  checkDestaque ? checkDestaque.checked : false
    };
    if (!produto.nome) { alert('Informe o nome do produto.'); return; }

    const editId = lerEditId();
    const imagemAtual = (document.getElementById('rs-imagem') || {}).value || null;
    // Na CRIAÇÃO lê as variações do form; na EDIÇÃO elas NÃO são tocadas (Fase 3).
    const variantes = (!editId && window.rsVariantes && window.rsVariantes.ler) ? window.rsVariantes.ler() : [];

    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
    try {
      // Só faz upload se o dono ESCOLHEU uma foto nova; editar sem trocar foto = zero upload.
      console.time('[admin] gravar produto');
      const salvo = await adicionarProduto(produto, arquivoSelecionado, variantes, editId, imagemAtual);
      console.timeEnd('[admin] gravar produto');

      // Atualiza a tabela pelo CACHE local (sem re-buscar no servidor) — evita round-trip.
      if (editId) {
        const i = produtosCache.findIndex(function (x) { return String(x.id) === String(editId); });
        if (i >= 0) produtosCache[i] = Object.assign({}, produtosCache[i], salvo);
      } else if (salvo) {
        produtosCache.unshift(salvo);
      }

      limparEditId();          // sai do modo edição (some do hidden)
      form.reset();            // reset também zera os hidden (rs-edit-id/rs-imagem)
      arquivoSelecionado = null;
      const imgHidden = document.getElementById('rs-imagem'); if (imgHidden) imgHidden.value = '';
      if (preview) preview.style.display = 'none';
      if (window.rsVariantes && window.rsVariantes.limpar) window.rsVariantes.limpar();
      renderTabelaFromCache();
      alert(editId ? 'Alterações salvas!' : 'Produto cadastrado com sucesso!');
    } catch (err) {
      // Mostra a mensagem real do erro quando existir (ajuda a diagnosticar)
      const msg = (err && err.message) ? err.message : 'Não foi possível salvar. Verifique se você está logado e tente novamente.';
      alert(msg);
    } finally {
      // Volta ao padrão se saiu do modo edição; mantém "Salvar alterações" se ainda editando (deu erro).
      if (btn) { btn.disabled = false; btn.textContent = lerEditId() ? 'Salvar alterações' : btnLabelPadrao; }
    }
  });

  renderTabelaAdmin();
}

// ===================================================================
// LÓGICA DO SITE
// ===================================================================

// Card para seção de destaques (product-card)
function gerarCardHTML(p) {
  var temVariantes = (p.variantes || []).filter(function(v){ return v.ativo !== false; }).length > 0;
  var precoAtual = precoExibicao(p);
  var temPromo = !temVariantes && p.preco_promo && p.preco_promo < p.preco;
  var foto = p.imagem_url || SEM_FOTO;
  // Estoque: null = não controla ("Sob consulta"); 0 = "Esgotado"; >0 = "N unidades".
  var est = estoqueTotal(p);
  var estTxt = (est == null) ? 'Sob consulta' : (est === 0 ? 'Esgotado' : est + ' unidades');

  return '<article class="product-card">' +
    '<div class="product-media">' +
      (p.badge ? '<div class="product-badges"><span class="pill rank gold">' + esc(p.badge) + '</span></div>' : '') +
      '<img class="product-photo" src="' + esc(foto) + '" alt="' + esc(p.nome) + '" loading="lazy"/>' +
    '</div>' +
    '<div class="product-info">' +
      '<span class="product-cat">' + esc(p.categoria || 'Produto') + '</span>' +
      '<h3 class="product-name">' + esc(p.nome) + '</h3>' +
      '<span class="product-stock' + (est === 0 ? ' esgotado' : '') + '">' + estTxt + '</span>' +
      '<div class="product-price">' +
        '<span class="current">' + formatarPreco(precoAtual) + '</span>' +
        (temPromo ? '<span class="original">' + formatarPreco(p.preco) + '</span>' : '') +
      '</div>' +
      '<a class="product-cta" href="produto.html?id=' + p.id + '" ' +
        'style="text-decoration:none;">' +
        'Comprar ' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>' +
        '</svg>' +
      '</a>' +
    '</div>' +
  '</article>';
}

// Card para catálogo (cat-card-mini)
function gerarCatCardHTML(p) {
  var foto = p.imagem_url || SEM_FOTO;
  var temVariantes = (p.variantes || []).filter(function(v){ return v.ativo !== false; }).length > 0;
  var temPromo = !temVariantes && p.preco_promo && p.preco_promo < p.preco;
  var precoAtual = precoExibicao(p);

  return '<article class="cat-card-mini">' +
    '<div class="cat-card-mini-media">' +
      '<img src="' + esc(foto) + '" alt="' + esc(p.nome) + '" loading="lazy"/>' +
    '</div>' +
    '<div class="cat-card-mini-body">' +
      '<span class="cat-card-mini-cat">' + esc(p.categoria || 'Produto') + '</span>' +
      '<h3>' + esc(p.nome) + '</h3>' +
      '<div class="cat-card-mini-foot">' +
        '<span class="price">' + formatarPreco(precoAtual) + '</span>' +
        '<a href="produto.html?id=' + p.id + '" class="add-btn" title="Ver produto">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>' +
        '</a>' +
      '</div>' +
    '</div>' +
  '</article>';
}

// Atualiza contadores com o total real de produtos
function atualizarContadores(total) {
  var el1 = document.getElementById('rs-total-produtos');
  if (el1) el1.textContent = total;

  var el2 = document.getElementById('rs-total-catalogo');
  if (el2) el2.textContent = total;

  var el3 = document.getElementById('rs-about-total');
  if (el3) el3.textContent = total + '+';
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

  // --- CATÁLOGO COMPLETO ---
  var containerCatalogo = document.getElementById('rs-catalogo');
  if (containerCatalogo) {
    var todos = await getProdutos({ somenteAtivos: true });

    // Atualiza contadores
    atualizarContadores(todos.length);

    if (todos.length === 0) {
      containerCatalogo.innerHTML =
        '<p style="grid-column:1/-1;text-align:center;padding:40px;color:#64748B">Catálogo em atualização. Volte em breve!</p>';
    } else {
      containerCatalogo.innerHTML = todos.map(gerarCatCardHTML).join('');
    }
  }
}

// ---------- Inicialização ----------
document.addEventListener('DOMContentLoaded', function () {
  initAdmin();
  initSite();
});
