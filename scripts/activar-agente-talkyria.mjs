// scripts/activar-agente-talkyria.mjs
// Ajuste de una sola vez sobre el agente que ya se creó (id fijo abajo):
// 1) lo activa (isActive: true) — necesario para poder usarlo en
//    /calls/trigger, si no la API responde 400 agent_not_found.
// 2) aplica la configuración avanzada (duración/silencio) que había
//    fallado antes por usar un id equivocado.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/activar-agente-talkyria.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const APP_BASE = 'https://app.talkyria.com/api/v1';
const AGENT_ID = 'cmu3f25bo008vjr040okfi2gv';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

console.log('1) Activando el agente (PATCH /agents/:id, isActive: true)...');
const actRes = await fetch(`${APP_BASE}/agents/${AGENT_ID}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ isActive: true })
});
const act = await actRes.json();
console.log('   Status:', actRes.status, JSON.stringify(act));

console.log('2) Aplicando configuración avanzada (PATCH /agents/:id/advanced)...');
const advRes = await fetch(`${APP_BASE}/agents/${AGENT_ID}/advanced`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    max_call_duration_ms: 25000,
    end_call_after_silence_ms: 3000,
    enable_backchannel: false,
    voicemail: { enabled: true, action: 'hangup' },
    handbook: { ai_disclosure: true, scope_boundaries: true }
  })
});
const adv = await advRes.json();
console.log('   Status:', advRes.status, JSON.stringify(adv));
