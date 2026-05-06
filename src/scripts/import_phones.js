// ============================================
// IMPORT PHONES SCRIPT - QUANTUM CRM
// Načte XLSX s telefonními čísly v 1. sloupci a vygeneruje SQL
// pro hromadný import leadů přiřazených AI agentu Eva.
//
// Použití:
//   node src/scripts/import_phones.js cesta/k/souboru.xlsx
//
// Výstup:
//   src/scripts/exports/import_phones_YYYY-MM-DD.sql
// ============================================

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ═══════════════════════════════════════════════════════════
// KONFIGURACE
// ═══════════════════════════════════════════════════════════
const AI_AGENT_UUID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb'; // Eva (Cante Trading / T-Mobile)
const EXPORTS_DIR = path.join(__dirname, 'exports');

// ═══════════════════════════════════════════════════════════
// VSTUP
// ═══════════════════════════════════════════════════════════
const inputFile = process.argv[2];

if (!inputFile) {
    console.error('❌ Chyba: Chybí cesta k XLSX souboru.');
    console.error('   Použití: node src/scripts/import_phones.js cesta/k/souboru.xlsx');
    process.exit(1);
}

if (!fs.existsSync(inputFile)) {
    console.error(`❌ Chyba: Soubor nenalezen: ${inputFile}`);
    process.exit(1);
}

console.log('🚀 Začínám import telefonních čísel pro Quantum CRM...\n');
console.log(`📂 Vstupní soubor: ${inputFile}`);
console.log(`👤 AI agent (assigned_to + created_by): ${AI_AGENT_UUID}\n`);

// ═══════════════════════════════════════════════════════════
// NORMALIZACE TELEFONU
// ═══════════════════════════════════════════════════════════
function normalizePhone(raw) {
    if (raw === null || raw === undefined || raw === '') return null;

    // String + odstranění whitespace, pomlček, závorek, teček
    let cleaned = String(raw).replace(/[\s\-\(\)\.]/g, '').trim();

    if (cleaned === '') return null;

    // Už má +420 prefix
    if (/^\+420\d{9}$/.test(cleaned)) return cleaned;

    // Začíná 420 (12 číslic) → přidat +
    if (/^420\d{9}$/.test(cleaned)) return '+' + cleaned;

    // 9 číslic bez prefixu → přidat +420
    if (/^\d{9}$/.test(cleaned)) return '+420' + cleaned;

    // Cokoli jiného → invalid
    return null;
}

// ═══════════════════════════════════════════════════════════
// NAČTENÍ XLSX
// ═══════════════════════════════════════════════════════════
console.log('📖 Čtu XLSX soubor...');

const workbook = XLSX.readFile(inputFile);
const sheetName = workbook.SheetNames[0];

if (!sheetName) {
    console.error('❌ Chyba: XLSX neobsahuje žádný list.');
    process.exit(1);
}

const worksheet = workbook.Sheets[sheetName];
const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
});

console.log(`   ✓ Načteno ${rawRows.length} řádků z listu "${sheetName}"\n`);

// ═══════════════════════════════════════════════════════════
// ZPRACOVÁNÍ
// ═══════════════════════════════════════════════════════════
console.log('🔍 Normalizuji a validuji telefonní čísla...');

const validPhones = new Set();   // deduplikace uvnitř souboru
const invalidRows = [];          // pro report
const duplicatesInFile = [];     // pro report

for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rawPhone = row[0]; // 1. sloupec

    const normalized = normalizePhone(rawPhone);

    if (!normalized) {
        invalidRows.push({ row: i + 1, value: rawPhone });
        continue;
    }

    if (validPhones.has(normalized)) {
        duplicatesInFile.push({ row: i + 1, phone: normalized });
        continue;
    }

    validPhones.add(normalized);
}

const phoneList = Array.from(validPhones);

console.log(`   ✓ Validních unikátních čísel: ${phoneList.length}`);
console.log(`   ⚠ Neplatných řádků: ${invalidRows.length}`);
console.log(`   ⚠ Duplikátů uvnitř souboru: ${duplicatesInFile.length}\n`);

if (phoneList.length === 0) {
    console.error('❌ Žádná validní čísla k importu. Končím.');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// VYTVOŘENÍ EXPORTS SLOŽKY
// ═══════════════════════════════════════════════════════════
if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    console.log(`📁 Vytvořena složka: ${EXPORTS_DIR}`);
}

// ═══════════════════════════════════════════════════════════
// GENEROVÁNÍ SQL
// ═══════════════════════════════════════════════════════════
const today = new Date().toISOString().split('T')[0];
const sqlFile = path.join(EXPORTS_DIR, `import_phones_${today}.sql`);

console.log(`💾 Generuji SQL do ${sqlFile}...`);

const sqlHeader = `-- ============================================
-- QUANTUM CRM - hromadný import telefonních čísel
-- Vygenerováno: ${today}
-- Vstupní soubor: ${path.basename(inputFile)}
-- Celkem leadů: ${phoneList.length}
-- Assigned to (AI agent Eva): ${AI_AGENT_UUID}
-- Deduplikace: WHERE NOT EXISTS proti phone
-- ============================================

`;

const sqlCommands = phoneList.map((phone) => {
    return `INSERT INTO leads (company_name, legal_form, ico, contact_person, phone, email, status, invoice_promised, assigned_to, created_by, created_at, updated_at) SELECT '', '', '', '', '${phone}', '', 'NOVY', false, '${AI_AGENT_UUID}', '${AI_AGENT_UUID}', NOW(), NOW() WHERE NOT EXISTS (SELECT 1 FROM leads WHERE phone = '${phone}');`;
}).join('\n');

fs.writeFileSync(sqlFile, sqlHeader + sqlCommands + '\n', 'utf8');

// ═══════════════════════════════════════════════════════════
// REPORTY (jen pokud je co reportovat)
// ═══════════════════════════════════════════════════════════
if (invalidRows.length > 0) {
    const invalidFile = path.join(EXPORTS_DIR, `invalid_phones_${today}.txt`);
    const invalidContent = invalidRows
        .map((r) => `Řádek ${r.row}: "${r.value}"`)
        .join('\n');
    fs.writeFileSync(invalidFile, invalidContent, 'utf8');
    console.log(`💾 Neplatné řádky uloženy do ${invalidFile}`);
}

if (duplicatesInFile.length > 0) {
    const dupFile = path.join(EXPORTS_DIR, `duplicates_in_file_${today}.txt`);
    const dupContent = duplicatesInFile
        .map((r) => `Řádek ${r.row}: ${r.phone}`)
        .join('\n');
    fs.writeFileSync(dupFile, dupContent, 'utf8');
    console.log(`💾 Duplikáty v souboru uloženy do ${dupFile}`);
}

// ═══════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════
console.log('\n✅ Hotovo!\n');
console.log('📊 Souhrn:');
console.log(`   • Načteno řádků: ${rawRows.length}`);
console.log(`   • Validních unikátních: ${phoneList.length}`);
console.log(`   • Neplatných: ${invalidRows.length}`);
console.log(`   • Duplikátů v souboru: ${duplicatesInFile.length}`);
console.log('\n📁 Výstup:');
console.log(`   • ${sqlFile}`);
console.log('\n🚀 Další krok:');
console.log('   1. Otevři pgAdmin → připoj se k Quantum DB');
console.log(`   2. Otevři ${path.basename(sqlFile)} jako Query`);
console.log('   3. Spusť (F5)');
console.log('   4. Po importu spusť AI volání přes UI nebo:');
console.log(`      fetch('https://quantum-1way.onrender.com/api/ai-calls/start', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxCalls: ${phoneList.length} }) }).then(r => r.json()).then(console.log)`);