<?php
/**
 * salvar.php - grava os jogos do painel em assets/json/game.json
 *
 * Compatível com hospedagem compartilhada (PHP 7.0+), sem banco de dados e
 * sem serviços externos. Deve ficar na mesma pasta do index.html.
 *
 * Uso (POST, JSON):
 *   { "usuario": "...", "senha": "...", "acao": "criar|atualizar|excluir",
 *     "jogo": {...}, "id": "...", "indice": 0, "semente": [...] }
 *
 * Teste de diagnóstico (GET): salvar.php?status
 *
 * Para trocar a senha: gere o SHA-256 da nova senha (ex.: https://www.php.net/hash
 * ou `echo -n "novaSenha" | sha256sum`), cole em PAINEL_SENHA_SHA256 abaixo e
 * altere também ADMIN_PASS em assets/js/painel.js.
 */

// ---------------------------------------------------------------- Configuração
define('PAINEL_USUARIO', 'admin');
define('PAINEL_SENHA_SHA256', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'); // "admin"

define('JSON_DIR', __DIR__ . '/assets/json');
define('JSON_FILE', JSON_DIR . '/game.json');
define('JSON_BACKUP', JSON_DIR . '/game.json.bak');
define('JSON_LOCK', JSON_DIR . '/.game.lock');
define('JSON_INIT', JSON_DIR . '/.game.init'); // criado após a primeira gravação bem-sucedida

define('MAX_BODY', 2 * 1024 * 1024); // 2 MB
define('MAX_GAMES', 5000);
define('MAX_FIELD', 2000);

$CAMPOS = array('titulo', 'idioma', 'tamanho', 'formato', 'ano', 'capa', 'banner', 'url-download', 'publicar-banner');

// ----------------------------------------------------------------- Ambiente
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

function responder($status, $dados)
{
    http_response_code($status);
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function falha($status, $mensagem, $erros = null)
{
    $r = array('ok' => false, 'message' => $mensagem);
    if ($erros) {
        $r['errors'] = $erros;
    }
    responder($status, $r);
}

set_error_handler(function ($no, $msg, $file, $line) {
    error_log("salvar.php: $msg em $file:$line");
    return true; // não vaza erros para o navegador
});
set_exception_handler(function ($e) {
    error_log('salvar.php: ' . $e->getMessage());
    falha(500, 'Erro interno ao salvar. Tente novamente.');
});

// ----------------------------------------------------------- Utilitários
function texto($v)
{
    if ($v === null) {
        return '';
    }
    if (is_bool($v)) {
        return $v ? '1' : '0';
    }
    return is_scalar($v) ? trim((string) $v) : '';
}

function tamanho($s)
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}

function url_http($v)
{
    if (!preg_match('#^https?://#i', $v) || preg_match('/[\s<>"]/', $v)) {
        return false;
    }
    $p = parse_url($v);
    return $p !== false && !empty($p['host']);
}

function ref_imagem($v)
{
    if (url_http($v)) {
        return true;
    }
    return (bool) preg_match('#^(\.{0,2}/)?[^\s:?\#]+\.[A-Za-z0-9]+([?\#]\S*)?$#', $v)
        && !preg_match('#^[a-z][a-z0-9+.-]*:#i', $v);
}

function publicar_ok($v)
{
    if ($v === true || $v === false) {
        return true;
    }
    return in_array(texto($v), array('Sim', 'Não', 'Nao', 'sim', 'não', 'nao'), true);
}

function chave_valida($k)
{
    return is_string($k) && preg_match('/^[A-Za-z0-9_-]{1,60}$/', $k);
}

// ------------------------------------------------------------ Leitura segura
function garantir_pasta()
{
    if (!is_dir(JSON_DIR)) {
        if (!@mkdir(JSON_DIR, 0775, true) && !is_dir(JSON_DIR)) {
            falha(500, 'A pasta assets/json não existe e não pôde ser criada.');
        }
    }
    if (!is_writable(JSON_DIR)) {
        @chmod(JSON_DIR, 0775);
        if (!is_writable(JSON_DIR)) {
            @chmod(JSON_DIR, 0777);
        }
    }
    if (file_exists(JSON_FILE) && !is_writable(JSON_FILE)) {
        @chmod(JSON_FILE, 0664);
        if (!is_writable(JSON_FILE)) {
            @chmod(JSON_FILE, 0666);
        }
    }
}

/** Retorna a lista de jogos. Lança falha() se o arquivo existir mas estiver corrompido. */
function ler_jogos()
{
    if (!file_exists(JSON_FILE)) {
        return array();
    }
    $raw = @file_get_contents(JSON_FILE);
    if ($raw === false) {
        falha(500, 'Não foi possível ler assets/json/game.json.');
    }
    if (substr($raw, 0, 3) === "\xEF\xBB\xBF") {
        $raw = substr($raw, 3);
    }
    if (trim($raw) === '') {
        return array();
    }
    $dados = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($dados)) {
        falha(500, 'O arquivo game.json está inválido. Nada foi alterado; corrija-o ou restaure game.json.bak.');
    }
    // aceita {"games":[...]} por tolerância, mas sempre regrava como lista
    if (isset($dados['games']) && is_array($dados['games'])) {
        $dados = $dados['games'];
    }
    if (array_keys($dados) !== range(0, count($dados) - 1) && count($dados) > 0) {
        falha(500, 'O game.json deve conter uma lista de jogos.');
    }
    return array_values($dados);
}

/** Grava com bloqueio, backup e arquivo temporário + rename (atômico). */
function gravar_jogos($lista)
{
    $json = json_encode(array_values($lista), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        falha(500, 'Não foi possível converter os dados para JSON.');
    }
    $json .= "\n";

    if (file_exists(JSON_FILE) && filesize(JSON_FILE) > 2) {
        @copy(JSON_FILE, JSON_BACKUP);
    }

    $tmp = JSON_DIR . '/.game.' . bin2hex(random_bytes(6)) . '.tmp';
    $ok = false;
    if (@file_put_contents($tmp, $json, LOCK_EX) === strlen($json)) {
        @chmod($tmp, 0664);
        $ok = @rename($tmp, JSON_FILE);
    }
    if (!$ok) {
        @unlink($tmp);
        // fallback (ex.: hospedagem Windows, onde rename sobre arquivo existente falha)
        $ok = @file_put_contents(JSON_FILE, $json, LOCK_EX) === strlen($json);
    }
    if (!$ok) {
        falha(500, 'Não foi possível gravar assets/json/game.json. Verifique as permissões da pasta (775/664).');
    }
    @chmod(JSON_FILE, 0664);

    // confere o que ficou gravado
    $check = json_decode((string) @file_get_contents(JSON_FILE), true);
    if (!is_array($check) || count($check) !== count($lista)) {
        if (file_exists(JSON_BACKUP)) {
            @copy(JSON_BACKUP, JSON_FILE);
        }
        falha(500, 'A verificação após a gravação falhou. O arquivo anterior foi restaurado.');
    }
    @file_put_contents(JSON_INIT, date('c'));
}

// ------------------------------------------------------------- Validação
function validar($v, $orig)
{
    global $CAMPOS;
    $e = array();
    foreach ($CAMPOS as $k) {
        $t = texto(isset($v[$k]) ? $v[$k] : null);
        if ($t === '') {
            $e[$k] = $k === 'titulo' ? 'Informe o título.' : 'Campo obrigatório.';
            continue;
        }
        if (tamanho($t) > ($k === 'titulo' ? 200 : MAX_FIELD)) {
            $e[$k] = 'Texto muito longo.';
            continue;
        }
        $mudou = $orig === null || texto(isset($orig[$k]) ? $orig[$k] : null) !== $t;
        if (!$mudou) {
            continue;
        }
        if (($k === 'capa' || $k === 'banner') && !ref_imagem($t)) {
            $e[$k] = 'Informe uma URL válida (https://...) da imagem.';
        } elseif ($k === 'url-download' && !url_http($t)) {
            $e[$k] = 'Informe uma URL válida começando com http:// ou https://.';
        } elseif ($k === 'publicar-banner' && !publicar_ok(isset($v[$k]) ? $v[$k] : null)) {
            $e[$k] = 'Valor inválido.';
        }
    }
    return $e;
}

/** Mantém apenas chaves seguras e valores simples (texto, número, booleano). */
function limpar_campos($v)
{
    $out = array();
    foreach ($v as $k => $val) {
        if (!chave_valida($k) || !(is_string($val) || is_int($val) || is_float($val) || is_bool($val))) {
            continue;
        }
        if (is_string($val)) {
            $val = trim($val);
            if (tamanho($val) > MAX_FIELD) {
                $val = function_exists('mb_substr') ? mb_substr($val, 0, MAX_FIELD, 'UTF-8') : substr($val, 0, MAX_FIELD);
            }
        }
        $out[$k] = $val;
    }
    return $out;
}

function slug($s)
{
    if (function_exists('iconv')) {
        $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        if ($t !== false) {
            $s = $t;
        }
    }
    $s = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $s));
    return substr(trim($s, '-'), 0, 60);
}

function novo_id($lista, $titulo)
{
    $ids = array();
    foreach ($lista as $g) {
        $ids[] = strtolower(texto(isset($g['id']) ? $g['id'] : ''));
    }
    $todos_num = count($ids) > 0;
    foreach ($ids as $i) {
        if (!ctype_digit($i)) {
            $todos_num = false;
            break;
        }
    }
    if ($todos_num) {
        $n = 0;
        foreach ($ids as $i) {
            $n = max($n, (int) $i);
        }
        $n++;
        while (in_array((string) $n, $ids, true)) {
            $n++;
        }
        return (string) $n;
    }
    $base = slug($titulo);
    if ($base === '') {
        $base = 'jogo';
    }
    $id = $base;
    $n = 2;
    while (in_array($id, $ids, true)) {
        $id = $base . '-' . $n++;
    }
    return $id;
}

function achar($lista, $id, $indice)
{
    if (is_int($indice) && $indice >= 0 && $indice < count($lista)
        && texto(isset($lista[$indice]['id']) ? $lista[$indice]['id'] : '') === $id) {
        return $indice;
    }
    foreach ($lista as $i => $g) {
        if (texto(isset($g['id']) ? $g['id'] : '') === $id) {
            return $i;
        }
    }
    return -1;
}

// -------------------------------------------------------- Autenticação/origem
function checar_origem()
{
    $origem = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
    if ($origem === '') {
        return;
    }
    $host = parse_url($origem, PHP_URL_HOST);
    $port = parse_url($origem, PHP_URL_PORT);
    $meu = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
    $o = strtolower($host . ($port ? ':' . $port : ''));
    if ($o !== strtolower($meu) && strtolower((string) $host) !== strtolower(preg_replace('/:\d+$/', '', $meu))) {
        falha(403, 'Origem não permitida.');
    }
}

function autenticar($d)
{
    $u = isset($d['usuario']) && is_string($d['usuario']) ? $d['usuario'] : '';
    $s = isset($d['senha']) && is_string($d['senha']) ? $d['senha'] : '';
    $ok = hash_equals(PAINEL_USUARIO, $u) && hash_equals(PAINEL_SENHA_SHA256, hash('sha256', $s));
    if (!$ok) {
        usleep(600000); // freia tentativas em massa
        falha(401, 'Não autorizado. Faça login novamente.');
    }
}

// ------------------------------------------------------------------ Status
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (!isset($_GET['status'])) {
        falha(405, 'Use POST para salvar.');
    }
    garantir_pasta();
    responder(200, array(
        'ok' => true,
        'php' => PHP_VERSION,
        'pasta_gravavel' => is_writable(JSON_DIR),
        'arquivo_existe' => file_exists(JSON_FILE),
        'arquivo_gravavel' => file_exists(JSON_FILE) ? is_writable(JSON_FILE) : is_writable(JSON_DIR),
        'iniciado' => file_exists(JSON_INIT),
    ));
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: GET, POST');
    falha(405, 'Método não permitido.');
}

checar_origem();

$len = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
if ($len > MAX_BODY) {
    falha(413, 'Requisição grande demais.');
}
$corpo = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($corpo === false || $corpo === '' || strlen($corpo) > MAX_BODY) {
    falha(400, 'Requisição vazia ou grande demais.');
}
$dados = json_decode($corpo, true, 32);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($dados)) {
    falha(400, 'JSON da requisição inválido.');
}

autenticar($dados);
garantir_pasta();

$acao = isset($dados['acao']) && is_string($dados['acao']) ? $dados['acao'] : '';
if (!in_array($acao, array('criar', 'atualizar', 'excluir'), true)) {
    falha(400, 'Ação inválida.');
}

// ---------------------------------------------- Região crítica (bloqueio)
$lock = @fopen(JSON_LOCK, 'c');
if (!$lock || !flock($lock, LOCK_EX)) {
    falha(500, 'Não foi possível bloquear o arquivo para gravação. Verifique as permissões da pasta assets/json.');
}

try {
    $lista = ler_jogos();

    // Migra o catálogo inicial (catalogo.js) apenas na primeira gravação, com o JSON ainda vazio.
    if (count($lista) === 0 && !file_exists(JSON_INIT)
        && isset($dados['semente']) && is_array($dados['semente'])) {
        if (count($dados['semente']) > MAX_GAMES) {
            falha(400, 'Catálogo inicial grande demais.');
        }
        foreach ($dados['semente'] as $g) {
            if (is_array($g) && !empty($g) && array_keys($g) !== range(0, count($g) - 1)) {
                $lista[] = $g;
            }
        }
    }

    $mensagem = '';
    $jogo = null;

    if ($acao === 'criar') {
        if (count($lista) >= MAX_GAMES) {
            falha(400, 'Limite de jogos atingido.');
        }
        $in = isset($dados['jogo']) && is_array($dados['jogo']) ? limpar_campos($dados['jogo']) : array();
        $erros = validar($in, null);
        if ($erros) {
            falha(422, 'Corrija os campos destacados para salvar.', $erros);
        }
        $in['id'] = novo_id($lista, texto(isset($in['titulo']) ? $in['titulo'] : ''));
        if (!isset($in['discussao'])) {
            $in['discussao'] = '';
        }
        $lista[] = $in;
        $jogo = $in;
        $mensagem = 'Jogo salvo em game.json.';
    } else {
        $id = isset($dados['id']) ? texto($dados['id']) : '';
        $indice = isset($dados['indice']) && is_int($dados['indice']) ? $dados['indice'] : -1;
        $pos = $id === '' ? -1 : achar($lista, $id, $indice);
        if ($pos < 0) {
            falha(409, 'Jogo não encontrado no servidor. Recarregue a página.');
        }
        if ($acao === 'atualizar') {
            $in = isset($dados['jogo']) && is_array($dados['jogo']) ? limpar_campos($dados['jogo']) : array();
            unset($in['id']);
            $novo = array_merge($lista[$pos], $in);
            $erros = validar($novo, $lista[$pos]);
            if ($erros) {
                falha(422, 'Corrija os campos destacados para salvar.', $erros);
            }
            $lista[$pos] = $novo;
            $jogo = $novo;
            $mensagem = 'Jogo atualizado em game.json.';
        } else {
            array_splice($lista, $pos, 1);
            $mensagem = 'Jogo removido de game.json.';
        }
    }

    gravar_jogos($lista);
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}

responder(200, array(
    'ok' => true,
    'message' => $mensagem,
    'jogo' => $jogo,
    'games' => array_values($lista),
));
