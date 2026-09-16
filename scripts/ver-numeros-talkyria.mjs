// scripts/ver-numeros-talkyria.mjs
// Diagnóstico de solo lectura: lista los números dedicados que ya
// compraste (GET /phones) y los caller IDs verificados que ya tienes
// (GET /verified-caller-ids). No compra ni cobra nada.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/ver-numeros-talkyria.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const API_BASE = 'https://app.talkyria.com/api/v1';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

console.log('--- GET /phones (números dedicados ya comprados) ---');
const phonesRes = await fetch(`${API_BASE}/phones`, { headers });
console.log('Status:', phonesRes.status);
console.log(JSON.stringify(await phonesRes.json(), null, 2));

console.log('\n--- GET /verified-caller-ids (números propios verificados) ---');
const vciRes = await fetch(`${API_BASE}/verified-caller-ids`, { headers });
console.log('Status:', vciRes.status);
console.log(JSON.stringify(await vciRes.json(), null, 2));
