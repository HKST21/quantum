// ============================================
// import_1stbatch.js
// Import telefonních čísel z 1stbatch.xlsx do Quantum CRM
//
// Použití:
//   node import_1stbatch.js
//
// Soubor 1stbatch.xlsx musí být ve stejné složce jako tento script.
// ============================================

const XLSX = require('xlsx');
const { Pool } = require('pg');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────────

const XLSX_FILE = '1stbatch.xlsx';

// Eva UUID — přiřazeno AI agentovi
const AI_AGENT_UUID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';

// ── DB CONNECTION ─────────────────────────────────────────────

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// ── HELPERS ───────────────────────────────────────────────────

function normalizePhone(raw) {
    if (!raw) return null;

    // Odstraň mezery, pomlčky, závorky
    let cleaned = String(raw).replace(/[\s\-\(\)\.]/g, '').trim();

    // Odstraň případné uvozovky
    cleaned = cleaned.replace(/['"]/g, '');

    // Pokud začíná 00420 → +420
    if (cleaned.startsWith('00420')) {
        cleaned = '+420' + cleaned.slice(5);
    }
    // Pokud začíná 420 (bez +) → +420
    else if (cleaned.startsWith('420') && cleaned.length === 12) {
        cleaned = '+' + cleaned;
    }
    // Pokud je 9 číslic → přidej +420
    else if (/^\d{9}$/.test(cleaned)) {
        cleaned = '+420' + cleaned;
    }

    // Validace: musí být +420 + 9 číslic
    if (!/^\+420\d{9}$/.test(cleaned)) {
        return null; // nevalidní
    }

    return cleaned;
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
    console.log('📂 Načítám soubor:', XLSX_FILE);

    // Načti Excel
    let workbook;
    try {
        workbook = XLSX.readFile(XLSX_FILE);
    } catch (err) {
        console.error('❌ Nelze načíst soubor:', XLSX_FILE);
        console.error('   Zkontroluj že je soubor ve stejné složce jako script.');
        process.exit(1);
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    console.log(`✅ Sheet: "${sheetName}", řádků: ${rows.length}`);

    // Parsuj telefonní čísla (přeskoč header pokud existuje)
    const phones = [];
    const invalid = [];

    for (let i = 0; i < rows.length; i++) {
        const raw = rows[i][0]; // první sloupec
        if (!raw || String(raw).trim() === '') continue;

        // Přeskoč header řádek pokud obsahuje text
        if (i === 0 && isNaN(Number(String(raw).replace(/[\s\+\-]/g, '')))) {
            console.log(`⏭️  Přeskakuji header: "${raw}"`);
            continue;
        }

        const normalized = normalizePhone(raw);
        if (normalized) {
            phones.push(normalized);
        } else {
            invalid.push({ row: i + 1, value: raw });
        }
    }

    console.log(`📞 Validních čísel: ${phones.length}`);
    if (invalid.length > 0) {
        console.log(`⚠️  Nevalidních čísel: ${invalid.length}`);
        invalid.slice(0, 5).forEach(x => console.log(`   Řádek ${x.row}: "${x.value}"`));
        if (invalid.length > 5) console.log(`   ... a dalších ${invalid.length - 5}`);
    }

    if (phones.length === 0) {
        console.error('❌ Žádná validní čísla, končím.');
        process.exit(1);
    }

    // Připoj se k DB
    const client = await pool.connect();
    console.log('✅ Připojeno k databázi');

    try {
        // Zjisti kolik čísel už existuje v DB
        const existingResult = await client.query(
            `SELECT phone FROM leads WHERE phone = ANY($1)`,
            [phones]
        );
        const existingPhones = new Set(existingResult.rows.map(r => r.phone));
        const newPhones = phones.filter(p => !existingPhones.has(p));

        console.log(`📊 Již v DB: ${existingPhones.size}`);
        console.log(`🆕 Nových k importu: ${newPhones.length}`);

        if (newPhones.length === 0) {
            console.log('ℹ️  Všechna čísla už jsou v databázi. Nic k importu.');
            return;
        }

        // Vlož po chunkách (1000 najednou)
        const CHUNK_SIZE = 500;
        let inserted = 0;

        for (let i = 0; i < newPhones.length; i += CHUNK_SIZE) {
            const chunk = newPhones.slice(i, i + CHUNK_SIZE);

            // Sestav VALUES pro bulk insert
            const values = chunk.map((phone, idx) => {
                const base = idx * 9;
                return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9})`;
            }).join(', ');

            const params = chunk.flatMap(phone => [
                '',           // company_name
                '',           // legal_form
                '',           // ico
                '',           // contact_person
                phone,        // phone
                '',           // email
                'NOVY',       // status
                AI_AGENT_UUID, // assigned_to = Eva
                AI_AGENT_UUID, // created_by = Eva
            ]);

            await client.query(`
                INSERT INTO leads
                    (company_name, legal_form, ico, contact_person, phone, email, status, assigned_to, created_by)
                VALUES ${values}
            `, params);

            inserted += chunk.length;
            console.log(`   ✅ Vloženo ${inserted} / ${newPhones.length}`);
        }

        console.log('');
        console.log('🎉 Import dokončen!');
        console.log(`   ✅ Nově vloženo: ${inserted}`);
        console.log(`   ⏭️  Přeskočeno (duplikáty): ${existingPhones.size}`);
        console.log(`   ⚠️  Nevalidní: ${invalid.length}`);
        console.log('');
        console.log('👉 Teď můžeš spustit AI volání přes CRM nebo:');
        console.log(`   curl -X POST https://quantum-1way.onrender.com/api/ai-calls/start \\`);
        console.log(`        -H "Content-Type: application/json" \\`);
        console.log(`        -d '{"maxCalls": 100}'`);

    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error('❌ Chyba:', err.message);
    process.exit(1);
});