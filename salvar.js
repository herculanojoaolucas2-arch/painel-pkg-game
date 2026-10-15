/**
 * salvar.js - servidor Node.js (Express) do painel PKG GAMES.
 *
 * - Serve o painel (index.html + /assets) e a API que grava os jogos em assets/json/game.json.
 * - Não usa localhost fixo: escuta em HOST (padrão 0.0.0.0) e na PORT definida pela hospedagem.
 * - HTTP ou HTTPS: normalmente a hospedagem/proxy cuida do HTTPS. Para HTTPS direto no Node,
 *   defina SSL_KEY e SSL_CERT (caminhos dos arquivos .pem).
 *
 * Variáveis de ambiente (todas opcionais):
 *   PORT               porta (padrão 3000)
 *   HOST               interface (padrão 0.0.0.0)
 *   PAINEL_USER        usuário do painel (padrão "admin")
 *   PAINEL_PASS_SHA256 SHA-256 da senha (padrão: hash de "admin")
 *                      gerar: node -e "console.log(require('crypto').createHash('sha256').update('NOVA_SENHA').digest('hex'))"
 *                      (troque também ADMIN_PASS em assets/js/painel.js)
 *   PAINEL_JSON_DIR    pasta do game.json (padrão assets/json)
 *   ALLOWED_ORIGINS    origens extras permitidas, separadas por vírgula (ex.: https://meusite.com)
 *   TRUST_PROXY        configuração "trust proxy" do Express (padrão: loopback, linklocal, uniquelocal)
 *   SSL_KEY / SSL_CERT HTTPS direto no Node
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- Configuração
const ROOT = __dirname;
const JSON_DIR = process.env.PAINEL_JSON_DIR ? path.resolve(process.env.PAINEL_JSON_DIR) : path.join(ROOT, 'assets', 'json');
const JSON_FILE = path.join(JSON_DIR, 'game.json');
const JSON_BACKUP = path.join(JSON_DIR, 'game.json.bak');
const JSON_LOCK = path.join(JSON_DIR, '.game.lock');
const JSON_INIT = path.join(JSON_DIR, '.game.init'); // criado após a primeira gravação bem-sucedida

const PAINEL_USER = process.env.PAINEL_USER || 'admin';
const PAINEL_PASS_SHA256 =
  process.env.PAINEL_PASS_SHA256 || '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'; // "admin"

const MAX_BODY = 2 * 1024 * 1024; // 2 MB
const MAX_GAMES = 5000;
const MAX_FIELD = 2000;
const CAMPOS = ['titulo', 'idioma', 'tamanho', 'formato', 'ano', 'capa', 'banner', 'url-download', 'publicar-banner'];

class HttpError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors || null;
  }
}

// ------------------------------------------------------------------ Utilitários
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ehObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const existe = (p) => fsp.access(p).then(() => true, () => false);
const comprimento = (s) => [...s].length;

function texto(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function urlHttp(v) {
  if (/[\s<>"]/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch (_) {
    return false;
  }
}

function refImagem(v) {
  if (urlHttp(v)) return true;
  return /^(\.{0,2}\/)?[^\s:?#]+\.[A-Za-z0-9]+([?#]\S*)?$/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v);
}

function publicarOk(v) {
  if (v === true || v === false) return true;
  return ['Sim', 'Não', 'Nao', 'sim', 'não', 'nao'].includes(texto(v));
}

const CHAVES_PROIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);
const chaveValida = (k) => /^[A-Za-z0-9_-]{1,60}$/.test(k) && !CHAVES_PROIBIDAS.has(k);

function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ------------------------------------------------------- Bloqueio (processo + arquivo)
let fila = Promise.resolve();

async function comArquivoLock(fn) {
  const inicio = Date.now();
  let fh;
  for (;;) {
    try {
      fh = await fsp.open(JSON_LOCK, 'wx', 0o664);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw new HttpError(500, 'Não foi possível bloquear o arquivo para gravação. Verifique as permissões da pasta assets/json.');
      }
      try {
        const st = await fsp.stat(JSON_LOCK);
        if (Date.now() - st.mtimeMs > 30000) {
          await fsp.unlink(JSON_LOCK).catch(() => {}); // trava abandonada
          continue;
        }
      } catch (_) {
        continue;
      }
      if (Date.now() - inicio > 10000) throw new HttpError(503, 'Servidor ocupado. Tente novamente em instantes.');
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await fh.close().catch(() => {});
    await fsp.unlink(JSON_LOCK).catch(() => {});
  }
}

function comBloqueio(fn) {
  const r = fila.then(() => comArquivoLock(fn));
  fila = r.catch(() => {});
  return r;
}

// ----------------------------------------------------------------- Arquivo JSON
async function garantirPasta() {
  try {
    await fsp.mkdir(JSON_DIR, { recursive: true });
    await fsp.access(JSON_DIR, fs.constants.W_OK);
  } catch (_) {
    throw new HttpError(500, 'A pasta assets/json não existe ou não permite gravação. Ajuste as permissões (775).');
  }
  if (await existe(JSON_FILE)) {
    try {
      await fsp.access(JSON_FILE, fs.constants.W_OK);
    } catch (_) {
      await fsp.chmod(JSON_FILE, 0o664).catch(() => {});
      try {
        await fsp.access(JSON_FILE, fs.constants.W_OK);
      } catch (_e) {
        throw new HttpError(500, 'O arquivo game.json não permite gravação. Ajuste as permissões (664).');
      }
    }
  }
}

/** Lê a lista de jogos. Se o arquivo existir mas estiver corrompido, falha SEM sobrescrever. */
async function lerJogos() {
  let raw;
  try {
    raw = await fsp.readFile(JSON_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new HttpError(500, 'Não foi possível ler assets/json/game.json.');
  }
  raw = raw.replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];
  let d;
  try {
    d = JSON.parse(raw);
  } catch (_) {
    throw new HttpError(500, 'O arquivo game.json está inválido. Nada foi alterado; corrija-o ou restaure game.json.bak.');
  }
  if (ehObj(d) && Array.isArray(d.games)) d = d.games;
  if (!Array.isArray(d) || d.some((g) => !ehObj(g))) {
    throw new HttpError(500, 'O game.json deve conter uma lista de jogos.');
  }
  return d;
}

/** Backup + arquivo temporário + fsync + rename (atômico) + verificação. */
async function gravarJogos(lista) {
  const json = JSON.stringify(lista, null, 2) + '\n';
  if (await existe(JSON_FILE)) {
    const st = await fsp.stat(JSON_FILE).catch(() => null);
    if (st && st.size > 2) await fsp.copyFile(JSON_FILE, JSON_BACKUP).catch(() => {});
  }

  const tmp = path.join(JSON_DIR, `.game.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let ok = false;
  try {
    const fh = await fsp.open(tmp, 'w', 0o664);
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, JSON_FILE);
    ok = true;
  } catch (_) {
    await fsp.unlink(tmp).catch(() => {});
    try {
      await fsp.writeFile(JSON_FILE, json, 'utf8'); // alternativa (ex.: rename bloqueado)
      ok = true;
    } catch (_e) {
      ok = false;
    }
  }
  if (!ok) throw new HttpError(500, 'Não foi possível gravar assets/json/game.json. Verifique as permissões da pasta (775/664).');
  await fsp.chmod(JSON_FILE, 0o664).catch(() => {});

  let confere = false;
  try {
    const check = JSON.parse(await fsp.readFile(JSON_FILE, 'utf8'));
    confere = Array.isArray(check) && check.length === lista.length;
  } catch (_) {}
  if (!confere) {
    if (await existe(JSON_BACKUP)) await fsp.copyFile(JSON_BACKUP, JSON_FILE).catch(() => {});
    throw new HttpError(500, 'A verificação após a gravação falhou. O arquivo anterior foi restaurado.');
  }
  await fsp.writeFile(JSON_INIT, new Date().toISOString()).catch(() => {});
}

// -------------------------------------------------------------------- Validação
function validar(v, orig) {
  const e = {};
  for (const k of CAMPOS) {
    const t = texto(v[k]);
    if (!t) {
      e[k] = k === 'titulo' ? 'Informe o título.' : 'Campo obrigatório.';
      continue;
    }
    if (comprimento(t) > (k === 'titulo' ? 200 : MAX_FIELD)) {
      e[k] = 'Texto muito longo.';
      continue;
    }
    if (orig && texto(orig[k]) === t) continue; // só valida o que mudou
    if ((k === 'capa' || k === 'banner') && !refImagem(t)) e[k] = 'Informe uma URL válida (https://...) da imagem.';
    else if (k === 'url-download' && !urlHttp(t)) e[k] = 'Informe uma URL válida começando com http:// ou https://.';
    else if (k === 'publicar-banner' && !publicarOk(v[k])) e[k] = 'Valor inválido.';
  }
  return e;
}

/** Mantém apenas chaves seguras e valores simples (texto, número, booleano). */
function limparCampos(v) {
  const out = {};
  if (!ehObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (!chaveValida(k)) continue;
    if (typeof val === 'string') out[k] = [...val.trim()].slice(0, MAX_FIELD).join('');
    else if ((typeof val === 'number' && Number.isFinite(val)) || typeof val === 'boolean') out[k] = val;
  }
  return out;
}

function novoId(lista, titulo) {
  const ids = lista.map((g) => texto(g.id).toLowerCase());
  if (ids.length && ids.every((i) => /^\d+$/.test(i))) {
    let n = Math.max(...ids.map(Number)) + 1;
    while (ids.includes(String(n))) n++;
    return String(n);
  }
  const base = slug(titulo) || 'jogo';
  let id = base;
  let n = 2;
  while (ids.includes(id)) id = `${base}-${n++}`;
  return id;
}

function achar(lista, id, indice) {
  if (Number.isInteger(indice) && indice >= 0 && indice < lista.length && texto(lista[indice].id) === id) return indice;
  return lista.findIndex((g) => texto(g.id) === id);
}

// ---------------------------------------------------------------- Autenticação
const tentativas = new Map(); // ip -> { falhas, ate }

function igual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function autenticar(dados, ip) {
  const t = tentativas.get(ip) || { falhas: 0, ate: 0 };
  if (t.ate > Date.now()) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns instantes.');
  const u = typeof dados.usuario === 'string' ? dados.usuario : '';
  const s = typeof dados.senha === 'string' ? dados.senha : '';
  const hash = crypto.createHash('sha256').update(s).digest('hex');
  const ok = igual(u, PAINEL_USER) & igual(hash, PAINEL_PASS_SHA256); // sem curto-circuito
  if (!ok) {
    t.falhas += 1;
    if (t.falhas >= 5) {
      t.ate = Date.now() + 60000;
      t.falhas = 0;
    }
    tentativas.set(ip, t);
    await sleep(600);
    throw new HttpError(401, 'Não autorizado. Faça login novamente.');
  }
  tentativas.delete(ip);
}

// ------------------------------------------------------------- Operações da API
async function status() {
  let pastaOk = false;
  try {
    await fsp.mkdir(JSON_DIR, { recursive: true });
    await fsp.access(JSON_DIR, fs.constants.W_OK);
    pastaOk = true;
  } catch (_) {}
  const arq = await existe(JSON_FILE);
  let arqOk = pastaOk;
  if (arq) arqOk = await fsp.access(JSON_FILE, fs.constants.W_OK).then(() => true, () => false);
  return {
    ok: true,
    node: process.version,
    pasta_gravavel: pastaOk,
    arquivo_existe: arq,
    arquivo_gravavel: arqOk,
    iniciado: await existe(JSON_INIT),
  };
}

async function listar() {
  return { ok: true, games: await lerJogos(), iniciado: await existe(JSON_INIT) };
}

async function salvar(dados, ip) {
  if (!ehObj(dados)) throw new HttpError(400, 'JSON da requisição inválido.');
  await autenticar(dados, ip);
  await garantirPasta();

  const acao = dados.acao;
  if (!['criar', 'atualizar', 'excluir'].includes(acao)) throw new HttpError(400, 'Ação inválida.');

  return comBloqueio(async () => {
    let lista = await lerJogos();

    // Migra o catálogo inicial (catalogo.js) só na primeira gravação, com o JSON ainda vazio.
    if (lista.length === 0 && !(await existe(JSON_INIT)) && Array.isArray(dados.semente)) {
      if (dados.semente.length > MAX_GAMES) throw new HttpError(400, 'Catálogo inicial grande demais.');
      lista = dados.semente.filter((g) => ehObj(g) && Object.keys(g).length > 0);
    }

    let mensagem = '';
    let jogo = null;

    if (acao === 'criar') {
      if (lista.length >= MAX_GAMES) throw new HttpError(400, 'Limite de jogos atingido.');
      const entrada = limparCampos(dados.jogo);
      const erros = validar(entrada, null);
      if (Object.keys(erros).length) throw new HttpError(422, 'Corrija os campos destacados para salvar.', erros);
      entrada.id = novoId(lista, texto(entrada.titulo));
      if (entrada.discussao === undefined) entrada.discussao = '';
      lista.push(entrada);
      jogo = entrada;
      mensagem = 'Jogo salvo em game.json.';
    } else {
      const id = texto(dados.id);
      const pos = id ? achar(lista, id, dados.indice) : -1;
      if (pos < 0) throw new HttpError(409, 'Jogo não encontrado no servidor. Recarregue a página.');
      if (acao === 'atualizar') {
        const entrada = limparCampos(dados.jogo);
        delete entrada.id;
        const novo = { ...lista[pos], ...entrada };
        const erros = validar(novo, lista[pos]);
        if (Object.keys(erros).length) throw new HttpError(422, 'Corrija os campos destacados para salvar.', erros);
        lista[pos] = novo;
        jogo = novo;
        mensagem = 'Jogo atualizado em game.json.';
      } else {
        lista.splice(pos, 1);
        mensagem = 'Jogo removido de game.json.';
      }
    }

    await gravarJogos(lista);
    return { ok: true, message: mensagem, jogo, games: lista };
  });
}

// ------------------------------------------------------------------ Servidor
function criarApp() {
  const express = require('express');
  const app = express();
  app.disable('x-powered-by');
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === undefined ? 'loopback, linklocal, uniquelocal' : tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const semCache = (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
  };

  const extras = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  function checarOrigem(req, res, next) {
    const origem = req.get('origin');
    if (!origem) return next();
    let host;
    try {
      host = new URL(origem).host.toLowerCase();
    } catch (_) {
      return next(new HttpError(403, 'Origem não permitida.'));
    }
    const meus = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map((h) => h.split(',')[0].trim().toLowerCase());
    if (meus.includes(host) || extras.includes(origem.toLowerCase())) return next();
    next(new HttpError(403, 'Origem não permitida.'));
  }

  // ---- API
  app.use('/api', semCache);
  app.get('/api/status', wrap(async (req, res) => res.json(await status())));
  app.get('/api/jogos', wrap(async (req, res) => res.json(await listar())));
  app.post(
    '/api/salvar',
    checarOrigem,
    express.json({ limit: MAX_BODY, strict: true }),
    wrap(async (req, res) => {
      const body = req.body;
      if (!ehObj(body) || Object.keys(body).length === 0) throw new HttpError(400, 'JSON da requisição inválido ou vazio.');
      res.json(await salvar(body, req.ip));
    }),
  );
  app.all('/api/*', (req, res, next) => next(new HttpError(req.path === '/api/salvar' ? 405 : 404, 'Rota da API não encontrada.')));

  // ---- Arquivos estáticos (somente o painel; nunca salvar.js, package.json, backups ou travas)
  app.get('/assets/json/game.json', semCache, (req, res) => {
    res.type('application/json');
    res.sendFile('game.json', { root: JSON_DIR, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).end();
    });
  });
  app.use('/assets', (req, res, next) => {
    let p;
    try {
      p = decodeURIComponent(req.path).toLowerCase();
    } catch (_) {
      return res.status(400).end();
    }
    if (p.startsWith('/json/') || p === '/json') return res.status(404).end();
    next();
  });
  app.use('/assets', express.static(path.join(ROOT, 'assets'), { index: false, dotfiles: 'ignore' }));
  app.get(['/', '/index.html'], (req, res) => res.sendFile('index.html', { root: ROOT }));

  // ---- Erros
  app.use((req, res, next) => next(new HttpError(404, 'Não encontrado.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let message = 'Erro interno ao salvar. Tente novamente.';
    let errors = null;
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
      errors = err.errors;
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      message = 'Requisição grande demais.';
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400;
      message = 'JSON da requisição inválido.';
    } else {
      console.error('[salvar.js]', err);
    }
    if (res.headersSent) return;
    const r = { ok: false, message };
    if (errors) r.errors = errors;
    res.status(status).json(r);
  });

  return app;
}

async function iniciar() {
  const app = criarApp();
  try {
    await fsp.mkdir(JSON_DIR, { recursive: true });
    if (!(await existe(JSON_FILE))) await fsp.writeFile(JSON_FILE, '[]\n', { mode: 0o664 });
    await garantirPasta();
  } catch (e) {
    console.warn('[salvar.js] Aviso:', e.message);
  }

  const p = process.env.PORT;
  const porta = p && !/^\d+$/.test(p) ? p : Number(p) || 3000; // aceita socket/pipe definido pela hospedagem
  const host = process.env.HOST || '0.0.0.0';

  let server;
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    server = require('https').createServer(
      { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) },
      app,
    );
  } else {
    server = require('http').createServer(app);
  }
  const ouvindo = () => console.log(`[salvar.js] Painel no ar (${process.env.SSL_KEY ? 'HTTPS' : 'HTTP'}), porta ${porta}.`);
  if (typeof porta === 'number') server.listen(porta, host, ouvindo);
  else server.listen(porta, ouvindo);

  const parar = () => server.close(() => process.exit(0));
  process.on('SIGTERM', parar);
  process.on('SIGINT', parar);
  return server;
}

process.on('unhandledRejection', (e) => console.error('[salvar.js] unhandledRejection:', e));

module.exports = { salvar, listar, status, HttpError, validar, JSON_FILE };

if (!process.env.SALVAR_TEST) {
  iniciar().catch((e) => {
    console.error('[salvar.js] Falha ao iniciar:', e);
    process.exit(1);
  });
}
