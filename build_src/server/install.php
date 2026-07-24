<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

header('Content-Type: text/html; charset=utf-8');
$done = false;
$error = '';
$generatedKey = '';

try {
    $c = accounting_config();
    ensure_dir(dirname($c['db_path']));
    ensure_dir($c['storage_path']);
    ensure_dir($c['backup_path']);
    ensure_dir($c['logs_path']);
    db();

    $deny = "Deny from all\n";
    @file_put_contents(__DIR__ . '/private/.htaccess', $deny, LOCK_EX);
    @file_put_contents(__DIR__ . '/private/index.html', '', LOCK_EX);

    if (!is_file(__DIR__ . '/openai.key')) {
        @file_put_contents(__DIR__ . '/openai.key', '', LOCK_EX);
        @chmod(__DIR__ . '/openai.key', 0600);
    }

    $done = true;
} catch (Throwable $e) {
    $error = $e->getMessage();
}

$c = accounting_config();
?><!doctype html>
<html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market-CY Accounting Installer</title>
<style>
body{margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#0f172a}.wrap{max-width:760px;margin:40px auto;padding:20px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:22px;padding:24px;box-shadow:0 12px 32px rgba(15,23,42,.08)}h1{margin:0 0 8px;font-size:27px}.sub{color:#64748b;margin-bottom:20px}.ok,.err{padding:14px;border-radius:14px;font-weight:700;margin:12px 0}.ok{background:#dcfce7;color:#166534}.err{background:#fee2e2;color:#991b1b}code{display:block;background:#0f172a;color:#e2e8f0;padding:14px;border-radius:12px;overflow:auto;margin:10px 0}.steps{line-height:1.7}.btn{display:inline-block;background:#0f172a;color:#fff;padding:13px 18px;border-radius:13px;text-decoration:none;font-weight:800;margin-top:12px}</style></head>
<body><div class="wrap"><div class="card">
<h1>Market-CY Accounting</h1>
<div class="sub">MASH TRADING &amp; DISTRIBUTION LTD · VAT CY60300156R</div>
<?php if ($done): ?>
<div class="ok">✅ Η ξεχωριστή βάση και όλοι οι φάκελοι δημιουργήθηκαν επιτυχώς.</div>
<div class="steps">
<strong>Database:</strong><code><?=htmlspecialchars($c['db_path'])?></code>
<strong>Storage:</strong><code><?=htmlspecialchars($c['storage_path'])?></code>
<strong>API:</strong><code><?=htmlspecialchars($c['base_url'])?>/index.php</code>
<strong>Τελευταίο βήμα:</strong> άνοιξε το αρχείο <code><?=htmlspecialchars(__DIR__ . '/openai.key')?></code> και βάλε μέσα μόνο το OpenAI API key. Το key μένει αποκλειστικά στον server.
</div>
<a class="btn" href="index.php?action=health&amp;key=<?=urlencode((string)$c['app_key'])?>">Έλεγχος API</a>
<?php else: ?><div class="err">❌ <?=htmlspecialchars($error)?></div><?php endif; ?>
</div></div></body></html>
