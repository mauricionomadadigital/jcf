// scripts/limpiar-config-agente.mjs
// Ajuste de una sola vez: quita la configuración avanzada que Talkyria
// dejó por default (parece una plantilla de confirmación de pedidos de
// e-commerce tipo Dropi) que probablemente esté empujando al agente a
// comportarse de forma conversacional en vez de seguir nuestro guion de
// "lee una vez y cuelga". También reintenta fijar la duración corta.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/limpiar-config-agente.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const APP_BASE = 'https://app.talkyria.com/api/v1';
const AGENT_ID = 'cmu3f25bo008vjr040okfi2gv';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

console.log('Limpiando analysis_fields y apagando banderas conversacionales del handbook...');
const res = await fetch(`${APP_BASE}/agents/${AGENT_ID}/advanced`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    max_call_duration_ms: 25000,
    end_call_after_silence_ms: 3000,
    ring_duration_ms: 20000,
    enable_backchannel: false,
    voicemail: { enabled: true, action: 'hangup' },
    analysis_fields: [],
    handbook: {
      default_personality: false,
      natural_filler_words: false,
      high_empathy: false,
      echo_verification: false,
      nato_phonetic_alphabet: false,
      speech_normalization: false,
      smart_matching: false,
      ai_disclosure: true,
      scope_boundaries: true
    }
  })
});
const data = await res.json();
console.log('Status:', res.status);
console.log(JSON.stringify(data, null, 2));
