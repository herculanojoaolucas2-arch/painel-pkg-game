(() => {
  'use strict';

  const ADMIN_USER = 'admin';
  const ADMIN_PASS = 'admin';

  const SITE_URL = '../pkg-game/';
  const DRAFT_KEY = 'pkg-games-rascunho';
  const JSON_URL = 'assets/json/game.json';
  const SAVE_URL = 'salvar.php';

  const PUB = 'publicar-banner';
  const FORM_FIELDS = [
    'titulo',
    'idioma',
    'tamanho',
    'formato',
    'ano',
    'capa',
    'banner',
    'url-download',
    PUB,
  ];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const isHttpUrl = (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  };
  const isImageRef = (v) =>
    isHttpUrl(v) || (/^(\.{0,2}\/)?[^\s:?#]+\.[A-Za-z0-9]+([?#]\S*)?$/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v));
  const resolveImg = (v) => {
    if (!v || isHttpUrl(v)) return v || '';
    try {
      return new URL(v, new URL(SITE_URL, location.href)).href;
    } catch (_) {
      return v;
    }
  };
  const pubOf = (g) => {
    const v = g ? g[PUB] : undefined;
    if (v === undefined || v === null || v === '') return 'Sim';
    if (v === false || v === 0) return 'Não';
    return ['nao', 'false', '0', 'off'].includes(norm(v)) ? 'Não' : 'Sim';
  };
  const origVal = (g, k) => (k === PUB ? pubOf(g) : str(g[k]).trim());
  const slugify = (s) =>
    norm(s)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

  const state = { games: [], query: '', editIdx: -1, dirty: false, seed: [], saving: false };
  let session = { user: '', pass: '' };

  function toast(msg, type = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<i class="bx ${type === 'error' ? 'bx-error-circle' : type === 'ok' ? 'bx-check-circle' : 'bx-info-circle'}"></i><span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const modals = [];
  function openModal(el) {
    el.hidden = false;
    modals.push(el);
    document.body.style.overflow = 'hidden';
    const f = $('input, button', el);
    if (f && matchMedia('(pointer: fine)').matches) setTimeout(() => f.focus(), 30);
  }
  function closeModal(el) {
    el.hidden = true;
    const i = modals.indexOf(el);
    if (i >= 0) modals.splice(i, 1);
    if (!modals.length) document.body.style.overflow = '';
  }

  let confirmResolve = null;
  function confirmDialog({ title, msg, yes = 'CONFIRMAR', danger = true }) {
    return new Promise((resolve) => {
      if (confirmResolve) confirmResolve(false);
      confirmResolve = resolve;
      $('#confirm-title').textContent = title;
      $('#confirm-msg').innerHTML = msg;
      $('#confirm-yes').textContent = yes;
      $('#confirm-yes').className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      openModal($('#modal-confirm'));
    });
  }
  function answerConfirm(v) {
    closeModal($('#modal-confirm'));
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(v);
  }

  function toList(data) {
    if (!Array.isArray(data)) throw new Error('O catálogo deve ser uma lista de jogos.');
    const bad = data.findIndex((g) => !isObj(g));
    if (bad >= 0) throw new Error(`O item ${bad + 1} do catálogo não é um jogo válido.`);
    return data;
  }

  function readDraft() {
    try {
      return toList(JSON.parse(localStorage.getItem(DRAFT_KEY)));
    } catch (_) {
      return null;
    }
  }
  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (_) {
      return;
    }
  }

  async function api(payload) {
    let res, data;
    try {
      res = await fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ ...payload, usuario: session.user, senha: session.pass }),
      });
    } catch (_) {
      throw new Error('Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.');
    }
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(
        res.status === 404
          ? 'salvar.php não encontrado. Envie-o para a mesma pasta do index.html.'
          : 'Resposta inválida do servidor. Confirme se a hospedagem executa PHP.',
      );
    }
    if (!res.ok || !data || data.ok !== true) {
      const err = new Error((data && data.message) || `Erro ${res.status} ao salvar.`);
      err.errors = (data && data.errors) || null;
      throw err;
    }
    toList(data.games);
    return data;
  }

  // Envia o catálogo inicial junto na 1ª gravação (o servidor só o usa se o JSON ainda estiver vazio).
  const seedPayload = () => (state.dirty && state.seed.length ? { semente: state.seed } : {});

  function applySaved(data) {
    state.games = data.games;
    state.seed = [];
    state.dirty = false;
    clearDraft();
  }

  function setState(kind, msg) {
    const box = $('#state');
    box.hidden = !kind;
    $('#list').hidden = !!kind;
    if (kind === 'loading')
      box.innerHTML = '<div class="spinner" aria-hidden="true"></div><p>Carregando catálogo...</p>';
    if (kind === 'error') {
      box.innerHTML = `<i class="bx bx-error-alt"></i><p>${esc(msg)}</p><button class="btn btn-primary" id="btn-retry" type="button"><i class="bx bx-refresh"></i>TENTAR NOVAMENTE</button>`;
      $('#btn-retry').addEventListener('click', load);
    }
  }

  async function fetchSaved() {
    const res = await fetch(`${JSON_URL}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = (await res.text()).replace(/^\uFEFF/, '').trim();
    return toList(txt ? JSON.parse(txt) : []);
  }

  async function serverStarted() {
    try {
      const res = await fetch(`${SAVE_URL}?status&_=${Date.now()}`, { cache: 'no-store' });
      const d = await res.json();
      return !!(d && d.iniciado);
    } catch (_) {
      return false;
    }
  }

  async function load() {
    setState('loading');
    try {
      let saved = null,
        why = '';
      try {
        saved = await fetchSaved();
      } catch (e) {
        why = e.message;
      }
      const fallback = () => {
        const draft = readDraft();
        return draft ?? (typeof GAMES !== 'undefined' ? toList(GAMES) : []);
      };
      state.seed = [];
      if (saved && (saved.length || (await serverStarted()))) {
        state.games = saved;
        state.dirty = false;
      } else {
        state.games = fallback();
        state.seed = state.games.slice();
        state.dirty = state.games.length > 0;
        if (!saved) toast(`Não foi possível ler ${JSON_URL} (${why}). Exibindo o catálogo inicial.`, 'error', 7000);
      }
      setState(null);
      render();
      const ids = new Set(),
        dup = state.games.find((g) => {
          const k = str(g.id).toLowerCase();
          if (ids.has(k)) return true;
          ids.add(k);
          return false;
        });
      if (dup) toast(`Atenção: ID duplicado no catálogo (${str(dup.id)}).`, 'error', 7000);
    } catch (e) {
      state.games = [];
      state.dirty = false;
      render();
      setState('error', e.message);
    }
  }

  function render() {
    const q = norm(state.query),
      total = state.games.length;
    const items = [];
    state.games.forEach((g, i) => {
      if (!q || [g.titulo, g.id, g.ano, g.idioma, g.formato].some((v) => norm(v).includes(q))) items.push([g, i]);
    });
    $('#count').textContent = q
      ? `${items.length} de ${total} ${total === 1 ? 'jogo' : 'jogos'}`
      : `${total} ${total === 1 ? 'jogo' : 'jogos'}`;
    $('#draft-note').textContent =
      'Exibindo o catálogo inicial. Ele será gravado em assets/json/game.json assim que você salvar a primeira alteração.';
    $('#draft-note').hidden = !state.dirty;
    $('#btn-discard').disabled = !state.dirty;
    $('#list').innerHTML = items.length
      ? items
          .map(
            ([g, i]) => `
      <article class="item" data-idx="${i}">
        <div class="th">${g.capa ? `<img src="${esc(resolveImg(g.capa))}" alt="" loading="lazy" draggable="false">` : '<i class="bx bx-image-alt"></i>'}</div>
        <h3 title="${esc(g.titulo)}">${esc(g.titulo) || '(sem título)'}</h3>
        <div class="acts">
          <button class="act" data-act="edit" type="button" aria-label="Editar ${esc(g.titulo)}"><i class="bx bx-edit-alt"></i><span>Editar</span></button>
          <button class="act del" data-act="del" type="button" aria-label="Excluir ${esc(g.titulo)}"><i class="bx bx-trash"></i><span>Excluir</span></button>
        </div>
      </article>`,
          )
          .join('')
      : `<p class="empty">${total ? 'Nenhum jogo encontrado.' : 'O catálogo está vazio. Clique em PUBLICAR NOVO JOGO.'}</p>`;
  }

  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.closest('.th'))
        t.replaceWith(Object.assign(document.createElement('i'), { className: 'bx bx-image-alt' }));
    },
    true,
  );

  const form = () => $('#game-form');
  const fld = (n) => form().elements[n];

  function clearErrors() {
    $$('.field.invalid').forEach((f) => f.classList.remove('invalid'));
    $$('[data-err]').forEach((e) => {
      e.textContent = '';
    });
    $('#form-error').hidden = true;
  }
  function setErr(name, msg) {
    const e = $(`[data-err="${name}"]`);
    if (e) {
      e.textContent = msg;
      e.closest('.field').classList.add('invalid');
    }
  }

  function openForm(idx = -1) {
    const g = state.games[idx] ?? null;
    state.editIdx = g ? idx : -1;
    clearErrors();
    form().reset();
    $('#form-title').textContent = g ? 'Editar jogo' : 'Publicar novo jogo';
    FORM_FIELDS.forEach((k) => {
      fld(k).value = k === PUB ? pubOf(g) : g ? str(g[k]).trim() : '';
    });
    openModal($('#modal-form'));
  }

  const readForm = () => Object.fromEntries(FORM_FIELDS.map((k) => [k, fld(k).value.trim()]));

  function validate(v, orig) {
    const e = {};
    FORM_FIELDS.forEach((k) => {
      if (!v[k]) e[k] = k === 'titulo' ? 'Informe o título.' : 'Campo obrigatório.';
    });
    const changed = (k) => !orig || origVal(orig, k) !== v[k];
    if (v.titulo.length > 200) e.titulo = 'No máximo 200 caracteres.';
    ['capa', 'banner'].forEach((k) => {
      if (v[k] && !e[k] && changed(k) && !isImageRef(v[k])) e[k] = 'Informe uma URL válida (https://...) da imagem.';
    });
    if (v['url-download'] && changed('url-download') && !isHttpUrl(v['url-download']))
      e['url-download'] = 'Informe uma URL válida começando com http:// ou https://.';
    return e;
  }

  function newId(list, titulo) {
    const ids = list.map((g) => str(g.id));
    const taken = new Set(ids.map((i) => i.toLowerCase()));
    if (ids.length && ids.every((i) => /^\d+$/.test(i))) {
      let n = Math.max(...ids.map(Number)) + 1;
      while (taken.has(String(n))) n++;
      return String(n);
    }
    const base = slugify(titulo) || 'jogo';
    let id = base,
      n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  function buildRecord(v, orig, list) {
    if (!orig) {
      return {
        id: newId(list, v.titulo),
        capa: v.capa,
        banner: v.banner,
        titulo: v.titulo,
        discussao: '',
        idioma: v.idioma,
        tamanho: v.tamanho,
        formato: v.formato,
        ano: v.ano,
        'url-download': v['url-download'],
        [PUB]: v[PUB],
      };
    }
    const rec = { ...orig };
    FORM_FIELDS.forEach((k) => {
      if (origVal(orig, k) === v[k]) return;
      rec[k] = typeof orig[k] === 'number' && /^-?\d+(\.\d+)?$/.test(v[k]) ? Number(v[k]) : v[k];
    });
    return rec;
  }

  async function onSave(ev) {
    ev.preventDefault();
    if (state.saving) return;
    clearErrors();
    const orig = state.games[state.editIdx] ?? null,
      v = readForm(),
      errs = validate(v, orig),
      keys = Object.keys(errs);
    if (keys.length) {
      keys.forEach((k) => setErr(k, errs[k]));
      $('#form-error').textContent =
        `Corrija ${keys.length === 1 ? 'o campo destacado' : 'os campos destacados'} para salvar.`;
      $('#form-error').hidden = false;
      fld(keys[0]).focus();
      return;
    }
    let payload = null;
    if (!orig) {
      payload = { acao: 'criar', jogo: buildRecord(v, null, state.games) };
    } else {
      const rec = buildRecord(v, orig, state.games);
      if (!same(rec, orig)) payload = { acao: 'atualizar', id: str(orig.id), indice: state.editIdx, jogo: rec };
    }
    if (!payload) {
      closeModal($('#modal-form'));
      toast('Nenhuma alteração para salvar.', 'info', 5000);
      return;
    }
    const btn = $('#btn-save');
    state.saving = true;
    btn.disabled = true;
    try {
      const data = await api({ ...payload, ...seedPayload() });
      applySaved(data);
      if (payload.acao === 'criar') {
        state.query = '';
        $('#search').value = '';
      }
      closeModal($('#modal-form'));
      render();
      toast(payload.acao === 'criar' ? 'Jogo salvo e publicado em game.json.' : 'Jogo atualizado em game.json.', 'ok', 5000);
    } catch (e) {
      const ek = Object.keys(e.errors || {});
      ek.forEach((k) => setErr(k, e.errors[k]));
      $('#form-error').textContent = ek.length ? e.message : `Não foi possível salvar: ${e.message}`;
      $('#form-error').hidden = false;
      if (ek.length && fld(ek[0])) fld(ek[0]).focus();
    } finally {
      state.saving = false;
      btn.disabled = false;
    }
  }

  async function deleteGame(idx) {
    const g = state.games[idx];
    if (!g) return;
    const ok = await confirmDialog({
      title: 'Excluir jogo',
      msg: `Excluir <strong>${esc(g.titulo) || esc(g.id)}</strong> do catálogo?<br><br>O jogo será removido de game.json.`,
      yes: 'EXCLUIR',
    });
    if (!ok) return;
    try {
      applySaved(await api({ acao: 'excluir', id: str(g.id), indice: idx, ...seedPayload() }));
      render();
      toast('Jogo removido de game.json.', 'ok', 5000);
    } catch (e) {
      toast(`Não foi possível excluir: ${e.message}`, 'error', 7000);
    }
  }

  function exportCatalog() {
    const url = URL.createObjectURL(
      new Blob([`const GAMES = ${JSON.stringify(state.games, null, 2)};\n`], { type: 'text/javascript' }),
    );
    const a = Object.assign(document.createElement('a'), { href: url, download: 'catalogo.js' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('catalogo.js exportado com os jogos atuais.', 'ok', 6000);
  }

  async function discardDraft() {
    const ok = await confirmDialog({
      title: 'Descartar rascunho',
      msg: 'Descartar o rascunho local e recarregar o catálogo salvo em <strong>game.json</strong>?',
      yes: 'DESCARTAR',
    });
    if (!ok) return;
    clearDraft();
    load();
  }

  let fails = 0,
    lockUntil = 0;
  function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    load();
  }
  function showLogin(msg) {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-pass').value = '';
    const err = $('#login-error');
    err.hidden = !msg;
    err.textContent = msg || '';
  }
  function onLogin(e) {
    e.preventDefault();
    const err = $('#login-error');
    const wait = Math.ceil((lockUntil - Date.now()) / 1000);
    if (wait > 0) {
      err.textContent = `Muitas tentativas. Aguarde ${wait}s.`;
      err.hidden = false;
      return;
    }
    const u = $('#login-user').value.trim(),
      p = $('#login-pass').value;
    if (!u || !p) {
      err.textContent = 'Informe usuário e senha.';
      err.hidden = false;
      return;
    }
    if (u === ADMIN_USER && p === ADMIN_PASS) {
      fails = 0;
      err.hidden = true;
      session = { user: u, pass: p };
      showApp();
    } else {
      if (++fails >= 5) {
        lockUntil = Date.now() + 15000;
        fails = 0;
      }
      err.textContent = 'Usuário ou senha incorretos.';
      err.hidden = false;
      $('#login-pass').value = '';
      $('#login-pass').focus();
    }
  }

  $('#login-form').addEventListener('submit', onLogin);
  $('#btn-logout').addEventListener('click', () => {
    state.games = [];
    session = { user: '', pass: '' };
    showLogin();
  });
  $('#btn-new').addEventListener('click', () => openForm(-1));
  $('#btn-export').addEventListener('click', exportCatalog);
  $('#btn-discard').addEventListener('click', discardDraft);
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });
  $('.search i').addEventListener('click', () => $('#search').focus());
  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'),
      item = e.target.closest('.item');
    if (!b || !item) return;
    const idx = +item.dataset.idx;
    if (b.dataset.act === 'edit') openForm(idx);
    else deleteGame(idx);
  });
  form().addEventListener('submit', onSave);
  form().addEventListener('input', (e) => {
    const f = e.target.closest('.field');
    if (f && f.classList.contains('invalid')) {
      f.classList.remove('invalid');
      const er = $('.err', f);
      if (er) er.textContent = '';
    }
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.closest('.modal'))));
  $('#confirm-yes').addEventListener('click', () => answerConfirm(true));
  $('#confirm-no').addEventListener('click', () => answerConfirm(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !modals.length) return;
    const top = modals[modals.length - 1];
    if (top.id === 'modal-confirm') answerConfirm(false);
    else closeModal(top);
  });

  showLogin();
})();
