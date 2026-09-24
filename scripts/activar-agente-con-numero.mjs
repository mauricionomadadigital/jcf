// scripts/activar-agente-con-numero.mjs
// Ajuste de una sola vez: asigna el verifiedCallerId ya verificado al
// agente existente y lo activa en el mismo PATCH (Talkyria no deja
// activar un agente sin número asignado).
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/activar-agente-con-numero.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const APP_BASE = 'https://app.talkyria.com/api/v1';
const AGENT_ID = 'cmu3f25bo008vjr040okfi2gv';
const VERIFIED_CALLER_ID = 'cmucz5in60002gm0av1tlqssq'; // +524681019708

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

console.log('Activando el agente con el número verificado...');
const res = await fetch(`${APP_BASE}/agents/${AGENT_ID}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ isActive: true, verifiedCallerIdId: VERIFIED_CALLER_ID })
});
const data = await res.json();
console.log('Status:', res.status);
console.log(JSON.stringify(data, null, 2));
