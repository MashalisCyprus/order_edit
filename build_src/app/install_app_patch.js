#!/usr/bin/env node
/* Market-CY MashScanner Accounting app patch installer */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const appDir = path.join(root, 'app');
const indexPath = path.join(appDir, 'index.js');
const packagePath = path.join(root, 'package.json');
const sourceAccounting = path.join(__dirname, 'app', 'accounting.js');
const targetAccounting = path.join(appDir, 'accounting.js');

function fail(msg) {
  console.error(`\n[ERROR] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(appDir)) fail('Δεν βρέθηκε ο φάκελος app/. Τρέξε το script μέσα στον κεντρικό φάκελο του MashScanner.');
if (!fs.existsSync(indexPath)) fail('Δεν βρέθηκε app/index.js.');
if (!fs.existsSync(sourceAccounting)) fail('Λείπει το αρχείο patch app/accounting.js.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, `_backup_marketcy_accounting_${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(indexPath, path.join(backupDir, 'index.js'));
if (fs.existsSync(packagePath)) fs.copyFileSync(packagePath, path.join(backupDir, 'package.json'));
if (fs.existsSync(targetAccounting)) fs.copyFileSync(targetAccounting, path.join(backupDir, 'accounting.js'));

let index = fs.readFileSync(indexPath, 'utf8');

if (!index.includes("router.push('/accounting')") && !index.includes('router.push("/accounting")')) {
  const anchor = `            <PremiumButton\n              icon="sparkles-outline"\n              title="Try Demo"`;
  const block = `            <PremiumButton\n              icon="calculator-outline"\n              title="Λογιστήριο"\n              subtitle="Τιμολόγια, προμηθευτές και αναφορές"\n              badge="ACCOUNT"\n              accent="#f59e0b"\n              onPress={() => router.push('/accounting')}\n            />\n\n`;
  if (!index.includes(anchor)) fail('Δεν βρέθηκε το αναμενόμενο σημείο στο app/index.js. Το backup δημιουργήθηκε και δεν έγινε αλλαγή.');
  index = index.replace(anchor, block + anchor);
}

if (!index.includes(`label="Λογιστήριο"`)) {
  const menuAnchor = `          <MenuItem icon="sparkles-outline" label="Try Demo" onPress={() => go('/demo')} />`;
  const menuBlock = `${menuAnchor}\n          <MenuItem icon="calculator-outline" label="Λογιστήριο" onPress={() => go('/accounting')} />`;
  if (index.includes(menuAnchor)) index = index.replace(menuAnchor, menuBlock);
}

index = index
  .replace('© DM MASH SUSHI RESTAURANT LTD', '© MASH TRADING & DISTRIBUTION LTD')
  .replace('Support:</Text> mashalis@kojopaphos.com', 'Support:</Text> admin@market-cy.com');

fs.writeFileSync(indexPath, index, 'utf8');
fs.copyFileSync(sourceAccounting, targetAccounting);

if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  if (!pkg.dependencies['expo-document-picker']) pkg.dependencies['expo-document-picker'] = '~14.0.7';
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

console.log('\n✅ Market-CY Accounting προστέθηκε στο MashScanner.');
console.log(`✅ Backup: ${backupDir}`);
console.log('➡️  Τρέξε: npx expo install expo-document-picker');
console.log('➡️  Μετά: npx expo start -c\n');
