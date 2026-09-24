// scripts/prueba-llamada-talkyria.mjs
// Prueba de una sola vez: confirma que el agente esté activo y dispara
// una llamada real de prueba al número indicado.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/prueba-llamada-talkyria.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const API_BASE = 'https://api.talkyria.com/api/v1';
const APP_BASE = 'https://app.talkyria.com/api/v1';
const AGENT_ID = 'cmu3f25bo008vjr040okfi2gv';
const TELEFONO_PRUEBA = '+524681577880';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

console.log('1) Confirmando que el agente esté activo...');
const getRes = await fetch(`${API_BASE}/agents`, { headers });
const { agents } = await getRes.json();
const agente = agents.find(a => a.id === AGENT_ID);

if (!agente) {
  console.error('No se encontró el agente.');
  process.exit(1);
}
console.log(`   isActive: ${agente.isActive}, hasCallerNumber: ${agente.hasCallerNumber}`);

if (!agente.isActive) {
  console.error('El agente sigue inactivo — no se dispara la llamada.');
  process.exit(1);
}

console.log(`2) Disparando llamada de prueba a ${TELEFONO_PRUEBA}...`);
const externalId = `prueba-manual-${Date.now()}`;
const callRes = await fetch(`${APP_BASE}/calls/trigger`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    externalId,
    agentId: AGENT_ID,
    customer: { name: 'Prueba Monitor JCF', phone: TELEFONO_PRUEBA },
    customVariables: { cv_municipio: 'Xichú (prueba)', cv_estado: 'Guanajuato (prueba)' },
    duplicateMode: 'OFF'
  })
});
const callData = await callRes.json().catch(() => ({}));
console.log('   Status:', callRes.status);
console.log('  ', JSON.stringify(callData, null, 2));

if (!callRes.ok && callData.code === 'wrong_host' && callData.correctUrl) {
  console.log('   Reintentando en el host correcto:', callData.correctUrl);
  const retryRes = await fetch(callData.correctUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      externalId,
      agentId: AGENT_ID,
      customer: { name: 'Prueba Monitor JCF', phone: TELEFONO_PRUEBA },
      customVariables: { cv_municipio: 'Xichú (prueba)', cv_estado: 'Guanajuato (prueba)' }
    })
  });
  console.log('   Status:', retryRes.status);
  console.log('  ', JSON.stringify(await retryRes.json(), null, 2));
}
