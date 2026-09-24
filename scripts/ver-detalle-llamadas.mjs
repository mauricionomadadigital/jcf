// scripts/ver-detalle-llamadas.mjs
// Diagnóstico de solo lectura: consulta el detalle real de las dos
// llamadas de prueba que se dispararon, para ver qué pasó (status,
// outcome, motivo de desconexión) más allá del "encolada" inicial.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/ver-detalle-llamadas.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const API_BASE = 'https://api.talkyria.com/api/v1';
const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

const CALLS = [
  { callId: 'cmufs0oer3crkqk472qx7cq80', orderId: 'cmufs0od0005fl004ad2ecr73', telefono: '+524191393305' },
  { callId: 'cmufsh2cr3d4rqk474bpi7ygn', orderId: 'cmufsh2ay007xl004vt2fkzs0', telefono: '+524732315642' }
];

for (const c of CALLS) {
  console.log(`\n=== Llamada a ${c.telefono} (callId ${c.callId}) ===`);
  const res = await fetch(`${API_BASE}/calls/${c.callId}`, { headers });
  console.log('GET /calls/{id} — Status:', res.status);
  console.log(JSON.stringify(await res.json().catch(() => ({})), null, 2));

  const res2 = await fetch(`${API_BASE}/orders/${c.orderId}/calls`, { headers });
  console.log('GET /orders/{id}/calls — Status:', res2.status);
  console.log(JSON.stringify(await res2.json().catch(() => ({})), null, 2));
}

console.log('\n=== Últimas llamadas de la cuenta (GET /calls) ===');
const resAll = await fetch(`${API_BASE}/calls?limit=10`, { headers });
console.log('Status:', resAll.status);
console.log(JSON.stringify(await resAll.json().catch(() => ({})), null, 2));
