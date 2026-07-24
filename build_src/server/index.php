<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-App-Key');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') exit;

$action = trim((string)($_GET['action'] ?? 'health'));
if ($action === 'report_view') {
    require_app_key();
    render_report();
}
require_app_key();

try {
    switch ($action) {
        case 'health':
            $c = accounting_config();
            db();
            json_response(['ok'=>true,'version'=>$c['version'],'company'=>$c['company_name'],'vat'=>$c['company_vat'],'database'=>'market-cy-separate']);
        case 'list': list_invoices();
        case 'suppliers': list_suppliers();
        case 'events': list_events();
        case 'upload': upload_invoice();
        case 'retry': retry_invoice();
        case 'update': update_invoice();
        case 'delete': delete_invoice();
        case 'report_link': report_link();
        default: json_response(['ok'=>false,'message'=>'Unknown action.'],404);
    }
} catch (Throwable $e) {
    event_log('api_error', null, $e->getMessage(), ['action'=>$action]);
    json_response(['ok'=>false,'message'=>$e->getMessage()],500);
}

function list_invoices(): never
{
    $where = ['deleted_at IS NULL']; $args = [];
    $year = (int)($_GET['year'] ?? 0); $month = (int)($_GET['month'] ?? 0);
    $status = trim((string)($_GET['status'] ?? '')); $supplier = (int)($_GET['supplier_id'] ?? 0);
    if ($year > 0) { $where[]='archive_year=?'; $args[]=$year; }
    if ($month > 0) { $where[]='archive_month=?'; $args[]=$month; }
    if ($status !== '') { $where[]='status=?'; $args[]=$status; }
    if ($supplier > 0) { $where[]='supplier_id=?'; $args[]=$supplier; }
    $sql='SELECT * FROM invoices WHERE '.implode(' AND ',$where).' ORDER BY COALESCE(issue_date,created_at) DESC,id DESC LIMIT 500';
    $s=db()->prepare($sql); $s->execute($args);
    json_response(['ok'=>true,'items'=>$s->fetchAll()]);
}

function list_suppliers(): never
{
    $rows=db()->query('SELECT id,name,vat_number FROM suppliers WHERE active=1 ORDER BY name')->fetchAll();
    json_response(['ok'=>true,'items'=>$rows]);
}

function list_events(): never
{
    $limit=max(1,min(100,(int)($_GET['limit'] ?? 20)));
    $s=db()->prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');
    $s->bindValue(1,$limit,PDO::PARAM_INT); $s->execute();
    json_response(['ok'=>true,'items'=>$s->fetchAll()]);
}

function upload_invoice(): never
{
    $c=accounting_config();
    if (empty($_FILES['file'])) throw new RuntimeException('Δεν παραλήφθηκε αρχείο.');
    $f=$_FILES['file'];
    if ((int)$f['error'] !== UPLOAD_ERR_OK) throw new RuntimeException('Upload error: '.(int)$f['error']);
    if ((int)$f['size'] <= 0 || (int)$f['size'] > (int)$c['max_upload_bytes']) throw new RuntimeException('Μη έγκυρο μέγεθος αρχείου.');
    $mime=(string)(mime_content_type($f['tmp_name']) ?: $f['type'] ?: 'application/octet-stream');
    if (!preg_match('~^(image/|application/pdf$)~i',$mime)) throw new RuntimeException('Επιτρέπονται εικόνες και PDF.');
    $ext=strtolower(pathinfo((string)$f['name'],PATHINFO_EXTENSION));
    if ($ext==='') $ext=$mime==='application/pdf'?'pdf':'jpg';
    $stored=gmdate('Y/m').'/'.bin2hex(random_bytes(16)).'.'.preg_replace('/[^a-z0-9]/','',$ext);
    $dest=$c['storage_path'].'/'.$stored; ensure_dir(dirname($dest));
    if (!move_uploaded_file($f['tmp_name'],$dest)) throw new RuntimeException('Αποτυχία αποθήκευσης αρχείου.');
    @chmod($dest,0640);
    $s=db()->prepare('INSERT INTO invoices(original_name,stored_name,mime_type,file_size,status,review_reason) VALUES(?,?,?,?,?,?)');
    $s->execute([(string)$f['name'],$stored,$mime,(int)$f['size'],'review','Αναμονή ανάλυσης.']);
    $id=(int)db()->lastInsertId();
    event_log('upload',$id,'Αποθηκεύτηκε αρχικό τιμολόγιο.');
    analyze_invoice($id);
    $row=db()->query('SELECT * FROM invoices WHERE id='.$id)->fetch();
    json_response(['ok'=>true,'item'=>$row]);
}

function retry_invoice(): never
{
    $id=(int)(read_json_body()['id'] ?? 0); if ($id<=0) throw new RuntimeException('Invoice id required.');
    analyze_invoice($id); json_response(['ok'=>true]);
}

function analyze_invoice(int $id): void
{
    $pdo=db(); $c=accounting_config();
    $s=$pdo->prepare('SELECT * FROM invoices WHERE id=? AND deleted_at IS NULL'); $s->execute([$id]); $inv=$s->fetch();
    if (!$inv) throw new RuntimeException('Το τιμολόγιο δεν βρέθηκε.');
    $key=openai_key();
    if ($key==='') {
        $pdo->prepare("UPDATE invoices SET status='review',review_reason='Λείπει το openai.key στον server.',updated_at=CURRENT_TIMESTAMP WHERE id=?")->execute([$id]);
        event_log('analysis_waiting',$id,'Λείπει OpenAI key.'); return;
    }
    $path=$c['storage_path'].'/'.$inv['stored_name'];
    $bytes=file_get_contents($path); if ($bytes===false) throw new RuntimeException('Δεν διαβάζεται το αρχικό αρχείο.');
    $b64=base64_encode($bytes); $mime=$inv['mime_type'];
    $prompt='Extract the current invoice only. Never use Balance, Previous Balance, Outstanding or Ageing Analysis as invoice amounts. Return JSON only with supplier_name, supplier_vat, invoice_number, issue_date YYYY-MM-DD, net_amount, vat_amount, total_amount, confidence, review_reason. Credit Sales Invoice is a normal invoice. Validate net + vat = total. If uncertain keep critical values null.';
    $content=[['type'=>'input_text','text'=>$prompt]];
    if ($mime==='application/pdf') $content[]=['type'=>'input_file','filename'=>$inv['original_name'],'file_data'=>'data:application/pdf;base64,'.$b64];
    else $content[]=['type'=>'input_image','image_url'=>'data:'.$mime.';base64,'.$b64];
    $payload=['model'=>$c['ai_model'],'input'=>[['role'=>'user','content'=>$content]],'text'=>['format'=>['type'=>'json_schema','name'=>'invoice','strict'=>true,'schema'=>['type'=>'object','additionalProperties'=>false,'properties'=>[
        'supplier_name'=>['type'=>['string','null']], 'supplier_vat'=>['type'=>['string','null']], 'invoice_number'=>['type'=>['string','null']], 'issue_date'=>['type'=>['string','null']],
        'net_amount'=>['type'=>['number','null']], 'vat_amount'=>['type'=>['number','null']], 'total_amount'=>['type'=>['number','null']], 'confidence'=>['type'=>'number'], 'review_reason'=>['type'=>['string','null']]
    ],'required'=>['supplier_name','supplier_vat','invoice_number','issue_date','net_amount','vat_amount','total_amount','confidence','review_reason']]]]];
    $ch=curl_init('https://api.openai.com/v1/responses');
    curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_POST=>true,CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$key,'Content-Type: application/json'],CURLOPT_POSTFIELDS=>json_encode($payload),CURLOPT_TIMEOUT=>120]);
    $raw=curl_exec($ch); $http=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE); $err=curl_error($ch); curl_close($ch);
    if ($raw===false || $http<200 || $http>=300) throw new RuntimeException('AI error '.$http.': '.($err ?: substr((string)$raw,0,300)));
    $resp=json_decode((string)$raw,true); $text='';
    foreach (($resp['output'] ?? []) as $o) foreach (($o['content'] ?? []) as $part) if (($part['type'] ?? '')==='output_text') $text.=(string)($part['text'] ?? '');
    $data=json_decode($text,true); if (!is_array($data)) throw new RuntimeException('AI JSON parse failed.');
    $name=trim((string)($data['supplier_name'] ?? '')); $vat=trim((string)($data['supplier_vat'] ?? '')); $num=trim((string)($data['invoice_number'] ?? '')); $date=trim((string)($data['issue_date'] ?? ''));
    $net=(float)($data['net_amount'] ?? 0); $tax=(float)($data['vat_amount'] ?? 0); $total=(float)($data['total_amount'] ?? 0); $confidence=(float)($data['confidence'] ?? 0);
    [$valid,$reason]=validate_amounts($net,$tax,$total);
    if ($date!=='' && !preg_match('/^\d{4}-\d{2}-\d{2}$/',$date)) { $date=''; $valid=false; $reason='Μη έγκυρη ημερομηνία.'; }
    $supplier=match_supplier($name,$vat); $supplierId=$supplier ? (int)$supplier['id'] : null;
    if (!$supplier && $name!=='' && $confidence>=0.92 && $vat!=='') $supplierId=create_supplier($name,$vat);
    elseif (!$supplier && $name!=='') { $valid=false; $reason=$reason ?: 'Χρειάζεται επιβεβαίωση προμηθευτή.'; }
    $year=$date!==''?(int)substr($date,0,4):0; $month=$date!==''?(int)substr($date,5,2):0;
    $status=($valid && $confidence>=0.88 && $num!=='' && $date!=='' && $supplierId)?'confirmed':'review';
    $review=$status==='confirmed'?'':($reason ?: (string)($data['review_reason'] ?? 'Χρειάζεται ανθρώπινος έλεγχος.'));
    $u=$pdo->prepare('UPDATE invoices SET supplier_id=?,supplier_name=?,supplier_vat=?,invoice_number=?,issue_date=?,archive_year=?,archive_month=?,net_amount=?,vat_amount=?,total_amount=?,status=?,review_reason=?,ai_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
    $u->execute([$supplierId,$name,$vat,$num,$date,$year,$month,$net,$tax,$total,$status,$review,json_encode($data,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES),$id]);
    event_log('analysis',$id,'Ολοκληρώθηκε ανάλυση.', ['status'=>$status,'confidence'=>$confidence]);
}

function update_invoice(): never
{
    $d=read_json_body(); $id=(int)($d['id'] ?? 0); if ($id<=0) throw new RuntimeException('Invoice id required.');
    $supplier=(int)($d['supplier_id'] ?? 0); $num=trim((string)($d['invoice_number'] ?? '')); $date=trim((string)($d['issue_date'] ?? ''));
    $net=(float)($d['net_amount'] ?? 0); $vat=(float)($d['vat_amount'] ?? 0); $total=(float)($d['total_amount'] ?? 0); $status=trim((string)($d['status'] ?? 'review'));
    if (!in_array($status,['review','confirmed','error','unclassified'],true)) $status='review';
    [$valid,$reason]=validate_amounts($net,$vat,$total); if ($status==='confirmed' && !$valid) throw new RuntimeException($reason);
    $name=''; $svat=''; if ($supplier>0) { $s=db()->prepare('SELECT name,vat_number FROM suppliers WHERE id=? AND active=1'); $s->execute([$supplier]); $r=$s->fetch(); if ($r){$name=$r['name'];$svat=$r['vat_number'];} }
    $year=$date!==''?(int)substr($date,0,4):0; $month=$date!==''?(int)substr($date,5,2):0;
    $s=db()->prepare('UPDATE invoices SET supplier_id=?,supplier_name=?,supplier_vat=?,invoice_number=?,issue_date=?,archive_year=?,archive_month=?,net_amount=?,vat_amount=?,total_amount=?,status=?,review_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
    $s->execute([$supplier?:null,$name,$svat,$num,$date,$year,$month,$net,$vat,$total,$status,$status==='confirmed'?'':$reason,$id]);
    event_log('manual_update',$id,'Χειροκίνητη ενημέρωση τιμολογίου.'); json_response(['ok'=>true]);
}

function delete_invoice(): never
{
    $id=(int)(read_json_body()['id'] ?? 0); if ($id<=0) throw new RuntimeException('Invoice id required.');
    db()->prepare('UPDATE invoices SET deleted_at=CURRENT_TIMESTAMP,status="unclassified",updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$id]);
    event_log('soft_delete',$id,'Μετακινήθηκε στα διαγραμμένα.'); json_response(['ok'=>true]);
}

function report_link(): never
{
    $d=read_json_body(); $q=http_build_query(['action'=>'report_view','year'=>(int)($d['year']??0),'month'=>(int)($d['month']??0),'supplier_id'=>(int)($d['supplier_id']??0),'key'=>accounting_config()['app_key']]);
    json_response(['ok'=>true,'url'=>rtrim(accounting_config()['base_url'],'/').'/index.php?'.$q]);
}

function render_report(): never
{
    $year=(int)($_GET['year']??0); $month=(int)($_GET['month']??0); $supplier=(int)($_GET['supplier_id']??0);
    $where=['deleted_at IS NULL','archive_year=?','archive_month=?']; $args=[$year,$month]; if($supplier>0){$where[]='supplier_id=?';$args[]=$supplier;}
    $s=db()->prepare('SELECT * FROM invoices WHERE '.implode(' AND ',$where).' ORDER BY issue_date,id');$s->execute($args);$rows=$s->fetchAll();
    $total=0; foreach($rows as $r)$total+=(float)$r['total_amount'];
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta name="viewport" content="width=device-width"><title>Market-CY Accounting</title><style>body{font-family:Arial;margin:24px;color:#0f172a}h1{margin:0}small{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}th{background:#f1f5f9}.num{text-align:right}.total{font-size:22px;font-weight:800;margin-top:18px}</style>';
    echo '<h1>MASH TRADING &amp; DISTRIBUTION LTD</h1><small>VAT CY60300156R · '.$year.'-'.str_pad((string)$month,2,'0',STR_PAD_LEFT).'</small><table><tr><th>Date</th><th>Supplier</th><th>Invoice</th><th>Status</th><th class="num">Total</th></tr>';
    foreach($rows as $r) echo '<tr><td>'.htmlspecialchars($r['issue_date']).'</td><td>'.htmlspecialchars($r['supplier_name']).'</td><td>'.htmlspecialchars($r['invoice_number']).'</td><td>'.htmlspecialchars($r['status']).'</td><td class="num">€'.number_format((float)$r['total_amount'],2).'</td></tr>';
    echo '</table><div class="total">Σύνολο: €'.number_format($total,2).'</div>'; exit;
}
