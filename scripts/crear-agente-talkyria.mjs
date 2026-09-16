// scripts/crear-agente-talkyria.mjs
//
// Corre esto UNA SOLA VEZ, en tu computadora (no es una función de
// Netlify), para crear el agente de Talkyria que usará Monitor JCF:
// uno configurado desde el inicio como aviso corto que cuelga solo, no
// como agente conversacional (que es como vienen por default, según te
// confirmó su soporte).
//
// Uso:
//   TALKYRIA_API_KEY=tk_test_TU_CLAVE node scripts/crear-agente-talkyria.mjs
//
// Usa primero una clave tk_test_... (sandbox) para probar sin gastar
// saldo ni hacer llamadas reales — cuando quieras el agente de verdad,
// vuelve a correrlo con tu clave tk_live_....
//
// Requiere Node 18 o más nuevo (usa fetch nativo, sin dependencias).

const API_KEY = process.env.TALKYRIA_API_KEY;
const APP_BASE = 'https://app.talkyria.com/api/v1';
const API_BASE = 'https://api.talkyria.com/api/v1';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY. Corre: TALKYRIA_API_KEY=tk_test_xxx node scripts/crear-agente-talkyria.mjs');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

// El prompt es lo que de verdad controla que sea un aviso y no una
// plática — así lo pidió Mauri, con el cierre natural que sugirió para
// que el agente sepa que ya puede colgar.
const PROMPT_AVISO = `Eres un sistema de avisos automatizados, NO un agente conversacional. Tu única función es leer el siguiente mensaje UNA VEZ y colgar inmediatamente después, sin hacer preguntas ni esperar respuesta:

"Aviso automático de Monitor JCF. El registro para {{cv_municipio}}, {{cv_estado}} ya está abierto. Entra ahora a la plataforma oficial para intentar registrarte. Muchas gracias por su atención. Este es un servicio de avisos automatizados, puede colgar ahora."

Reglas estrictas:
- No inicies ninguna conversación ni hagas preguntas.
- Si la persona dice algo, responde como máximo con un agradecimiento muy breve y despídete.
- Cuelga la llamada en cuanto termines de leer el mensaje, o unos segundos después si detectas silencio.
- Nunca improvises información adicional sobre el programa — no eres soporte de Jóvenes Construyendo el Futuro, solo un aviso.`;

async function main() {
  console.log('1) Verificando la clave (GET /me)...');
  const meRes = await fetch(`${API_BASE}/me`, { headers });
  const me = await meRes.json();
  if (!meRes.ok) {
    console.error('La clave no funcionó:', me.code, me.message);
    process.exit(1);
  }
  console.log('   OK — clave válida.', JSON.stringify(me));

  console.log('2) Creando el agente (POST /agents)...');
  const createRes = await fetch(`${APP_BASE}/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      integration: 'universal',
      mission: 'custom',
      name: 'Monitor JCF — Aviso de apertura',
      description: 'Llamada corta y automática cuando un municipio abre registro. No conversacional.',
      language: 'es',
      useCustomPrompt: true,
      customPrompt: PROMPT_AVISO,
      enableVoicemailDetection: true,
      maxCallDuration: 30,
      isActive: true
    })
  });
  const body = await createRes.json();
  if (!createRes.ok) {
    console.error('No se pudo crear el agente:', body.code, body.message);
    process.exit(1);
  }
  // La API a veces envuelve la respuesta (p.ej. { agent: {...} }) en vez de
  // devolver el agente directo con "id" en la raíz — cubrimos ambos casos.
  const agente = body.agent || body.data || body;
  if (!agente.id) {
    console.warn('   Aviso: no se encontró "id" en la respuesta. Respuesta completa:', JSON.stringify(body));
  }
  console.log('   OK — agente creado con id:', agente.id);

  if (agente.isActive === false) {
    console.log('   Activando el agente (isActive: true)...');
    const actRes = await fetch(`${APP_BASE}/agents/${agente.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ isActive: true })
    });
    if (!actRes.ok) {
      const errAct = await actRes.json().catch(() => ({}));
      console.warn('   No se pudo activar el agente automáticamente:', errAct.code, errAct.message);
      console.warn('   Actívalo a mano en el panel de Talkyria antes de usarlo en llamadas.');
    } else {
      console.log('   OK — agente activado.');
    }
  }

  console.log('3) Ajustando configuración avanzada (PATCH /agents/:id/advanced)...');
  const advRes = await fetch(`${APP_BASE}/agents/${agente.id}/advanced`, {
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
  if (!advRes.ok) {
    console.warn('   El agente se creó pero la configuración avanzada falló:', adv.code, adv.message);
    console.warn('   No es grave — el agente ya sirve, solo ajusta esto a mano en el panel si quieres.');
  } else {
    console.log('   OK — configuración avanzada aplicada.');
  }

  console.log('\n✅ Listo. Agrega esta variable de entorno en Netlify:\n');
  console.log(`   TALKYRIA_AGENT_ID=${agente.id}\n`);
  console.log('Con una clave tk_test_... este agente no hace llamadas reales — cuando');
  console.log('tengas tu clave tk_live_... real, vuelve a correr este script para crear');
  console.log('la versión de producción y actualiza TALKYRIA_AGENT_ID con ese nuevo id.');
}

main().catch(err => {
  console.error('Error inesperado:', err.message);
  process.exit(1);
});
