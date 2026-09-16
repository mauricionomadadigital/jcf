// scripts/listar-agentes-talkyria.mjs
// Diagnóstico de una sola vez: lista los agentes de la cuenta para ver
// la forma real de la respuesta de la API y encontrar el id del agente
// "Monitor JCF — Aviso de apertura" que ya se creó.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/listar-agentes-talkyria.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const API_BASE = 'https://api.talkyria.com/api/v1';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

const res = await fetch(`${API_BASE}/agents`, { headers });
const data = await res.json();
console.log('Status:', res.status);
console.log(JSON.stringify(data, null, 2));
