<?php
declare(strict_types=1);

return [
    'app_name' => 'Market-CY Accounting',
    'version' => '1.0.0',
    'company_name' => 'MASH TRADING & DISTRIBUTION LTD',
    'company_vat' => 'CY60300156R',
    'base_url' => 'https://market-cy.com/accounting',
    'app_key' => '__APP_KEY__',
    'ai_model' => 'gpt-5-mini',
    'db_path' => __DIR__ . '/private/accounting.sqlite',
    'storage_path' => __DIR__ . '/private/storage',
    'backup_path' => __DIR__ . '/private/backups',
    'logs_path' => __DIR__ . '/private/logs',
    'openai_key_file' => __DIR__ . '/openai.key',
    'max_upload_bytes' => 25 * 1024 * 1024,
    'retention_years' => 7,
];
