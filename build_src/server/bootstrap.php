<?php
declare(strict_types=1);

function accounting_config(): array
{
    static $config;
    if (!$config) $config = require __DIR__ . '/config.php';
    return $config;
}

function ensure_dir(string $dir): void
{
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        throw new RuntimeException('Cannot create directory: ' . $dir);
    }
}

function db(): PDO
{
    static $pdo;
    if ($pdo instanceof PDO) return $pdo;
    $c = accounting_config();
    ensure_dir(dirname($c['db_path']));
    ensure_dir($c['storage_path']);
    ensure_dir($c['backup_path']);
    ensure_dir($c['logs_path']);
    $pdo = new PDO('sqlite:' . $c['db_path'], null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 15,
    ]);
    $pdo->exec('PRAGMA foreign_keys=ON');
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec('PRAGMA busy_timeout=15000');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        vat_number TEXT DEFAULT '',
        aliases_json TEXT DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        merged_into INTEGER DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (merged_into) REFERENCES suppliers(id)
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_vat ON suppliers(vat_number) WHERE vat_number <> '' AND active=1");
    $pdo->exec("CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER DEFAULT NULL,
        supplier_name TEXT DEFAULT '',
        supplier_vat TEXT DEFAULT '',
        invoice_number TEXT DEFAULT '',
        issue_date TEXT DEFAULT '',
        archive_year INTEGER NOT NULL DEFAULT 0,
        archive_month INTEGER NOT NULL DEFAULT 0,
        net_amount REAL NOT NULL DEFAULT 0,
        vat_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'review',
        review_reason TEXT DEFAULT '',
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        ai_json TEXT DEFAULT '{}',
        deleted_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_supplier_number ON invoices(supplier_id, invoice_number) WHERE invoice_number <> '' AND deleted_at IS NULL");
    $pdo->exec("CREATE INDEX IF NOT EXISTS ix_invoice_month ON invoices(archive_year, archive_month, status)");
    $pdo->exec("CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        invoice_id INTEGER DEFAULT NULL,
        message TEXT DEFAULT '',
        meta_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
}

function json_response(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function normalize_name(string $value): string
{
    $value = mb_strtoupper(trim($value), 'UTF-8');
    $value = preg_replace('/\b(LTD|LIMITED|LLC|PLC|CO|COMPANY)\b/u', ' ', $value) ?: $value;
    $value = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?: $value;
    return trim(preg_replace('/\s+/u', ' ', $value) ?: $value);
}

function event_log(string $action, ?int $invoiceId, string $message, array $meta = []): void
{
    $stmt = db()->prepare('INSERT INTO events(action, invoice_id, message, meta_json) VALUES(?,?,?,?)');
    $stmt->execute([$action, $invoiceId, $message, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
}

function require_app_key(): void
{
    $expected = (string)accounting_config()['app_key'];
    $provided = trim((string)($_SERVER['HTTP_X_APP_KEY'] ?? $_GET['key'] ?? ''));
    if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        json_response(['ok' => false, 'message' => 'Unauthorized app request.'], 403);
    }
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $_POST;
}

function openai_key(): string
{
    $file = accounting_config()['openai_key_file'];
    if (is_file($file)) return trim((string)file_get_contents($file));
    return trim((string)getenv('OPENAI_API_KEY'));
}

function validate_amounts(float $net, float $vat, float $total): array
{
    if ($total <= 0) return [false, 'Δεν εντοπίστηκε έγκυρο τελικό σύνολο.'];
    if ($net < 0 || $vat < 0) return [false, 'Βρέθηκαν αρνητικά ποσά.'];
    if ($net > 0 && abs(($net + $vat) - $total) > 0.03) return [false, 'Η καθαρή αξία + ΦΠΑ δεν συμφωνεί με το σύνολο.'];
    return [true, ''];
}

function match_supplier(string $name, string $vat): ?array
{
    $pdo = db();
    $vat = strtoupper(preg_replace('/\s+/', '', trim($vat)) ?: '');
    if ($vat !== '') {
        $s = $pdo->prepare('SELECT * FROM suppliers WHERE active=1 AND REPLACE(UPPER(vat_number)," ","")=? LIMIT 1');
        $s->execute([$vat]);
        if ($row = $s->fetch()) return $row;
    }
    $norm = normalize_name($name);
    if ($norm !== '') {
        $s = $pdo->prepare('SELECT * FROM suppliers WHERE active=1 AND normalized_name=? LIMIT 1');
        $s->execute([$norm]);
        if ($row = $s->fetch()) return $row;
    }
    return null;
}

function create_supplier(string $name, string $vat): int
{
    $name = trim($name);
    if ($name === '') throw new RuntimeException('Supplier name required.');
    $stmt = db()->prepare('INSERT INTO suppliers(name, normalized_name, vat_number) VALUES(?,?,?)');
    $stmt->execute([$name, normalize_name($name), strtoupper(trim($vat))]);
    return (int)db()->lastInsertId();
}
