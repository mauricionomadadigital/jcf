// scripts/actualizar-guion-agente.mjs
// Actualiza el customPrompt del agente ya existente con el guion tipo
// "alarma" (repetido ~5 veces, ~20 segundos) — sin crear un agente nuevo.
//
// Uso:
//   TALKYRIA_API_KEY=tk_live_TU_CLAVE node scripts/actualizar-guion-agente.mjs

const API_KEY = process.env.TALKYRIA_API_KEY;
const APP_BASE = 'https://app.talkyria.com/api/v1';
const AGENT_ID = 'cmu3f25bo008vjr040okfi2gv';

if (!API_KEY) {
  console.error('Falta TALKYRIA_API_KEY.');
  process.exit(1);
}

const PROMPT_AVISO = `Eres un sistema de avisos automatizados, NO un agente conversacional. Tu única función es leer el siguiente mensaje, tal cual está escrito, UNA SOLA VEZ de principio a fin, y colgar inmediatamente después — no inicies ninguna conversación, no hagas preguntas, no esperes respuesta, no improvises nada fuera de este texto:

"¡Alerta! Tu municipio, {{cv_municipio}}, en {{cv_estado}}, ya abrió su registro.
¡Alerta! Entra ahora a la plataforma oficial y regístrate cuanto antes.
¡Alerta! {{cv_municipio}} está abierto en este momento, no pierdas tu lugar.
¡Alerta! Regístrate ya en la plataforma oficial de Jóvenes Construyendo el Futuro.
¡Alerta! Tu municipio ya abrió su registro. Puede colgar ahora, gracias."

Reglas estrictas:
- No inicies ninguna conversación ni hagas preguntas, ni siquiera para saludar o preguntar quién contesta.
- Si la persona dice algo mientras hablas o después, ignóralo o responde como máximo con un agradecimiento muy breve, y sigue/termina el mensaje de arriba tal cual.
- Cuelga la llamada en cuanto termines de leer el mensaje completo, o unos segundos después si detectas silencio.
- Nunca improvises información adicional sobre el programa, ni preguntes por pedidos, direcciones, productos ni nada — no eres soporte de Jóvenes Construyendo el Futuro ni un agente de ventas, solo un aviso.`;

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

console.log('Actualizando el guion del agente...');
const res = await fetch(`${APP_BASE}/agents/${AGENT_ID}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ useCustomPrompt: true, customPrompt: PROMPT_AVISO })
});
const data = await res.json();
console.log('Status:', res.status);
console.log(JSON.stringify(data, null, 2));
