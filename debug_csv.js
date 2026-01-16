
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const csvPath = path.join(__dirname, 'public/data/inventory.csv');
const data = fs.readFileSync(csvPath, 'utf8');

const parseCSV = (text) => {
    const lines = text.split(/\r?\n/);
    const rows = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const row = line.split(',');
        rows.push(row);
    }
    return rows;
};

const rows = parseCSV(data);
const header = rows[0];
const skuIndex = header.findIndex(h => h.includes('SKU'));
const locIndex = header.findIndex(h => h.includes('Property'));
const qtyIndex = header.findIndex(h => h.includes('Counted_Qty'));
const uidIndex = header.findIndex(h => h.includes('Count_UID'));

const targetSKU = '2025032301';
// Only checking the 55 entry
const matches = rows.filter(r => r[skuIndex] && r[skuIndex].includes(targetSKU) && r[locIndex] === 'MGC' && r[qtyIndex] === '55');

console.log(`Found ${matches.length} MGC matches with qty 55:`);
matches.forEach(m => {
    const uid = m[uidIndex] || '';
    const valid = /^[0-9a-fA-F]{8,}$/.test(uid) || /^[0-9a-fA-F]{8,}/.test(uid); // Regex in App.jsx checks pattern followed by comma
    // App regex: /\r?\n(?![0-9a-fA-F]{8,},)/g
    // So the line must START with hex(8+),
    console.log(`UID: '${uid}', ValidStart: ${/^[0-9a-fA-F]{8,}$/.test(uid)}`);
});
