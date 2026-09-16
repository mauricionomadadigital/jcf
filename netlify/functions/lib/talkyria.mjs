// netlify/functions/lib/talkyria.mjs
//
// Escrito contra la documentación real: https://app.talkyria.com/docs/api
// (contrato OpenAPI, ya no es una adivinanza como la primera versión).
//
// Puntos clave de su API que cambian el diseño:
//
// - No existe un campo "di este texto" en la petición de llamada. Talkyria
//   es un motor de IA conversacional: lo que se dice lo define el PROMPT
//   del AGENTE (configurado una vez en su panel o por API), no cada
//   llamada. Por eso hace falta un agentId — ver
//   scripts/crear-agente-talkyria.mjs, que crea ese agente ya configurado
//   como aviso-y-cuelga (no conversacional), en vez de dejarlo a mano.
// - Por llamada solo mandamos customVariables (claves cv_*) con los datos
//   que cambian — municipio y estado — para que el agente los mencione.
// - `externalId` es la clave de idempotencia: reusamos nuestra misma
//   clave anti-duplicado (`evento`) como para no llamar dos veces por el
//   mismo suscriptor+municipio+apertura, con protección doble (la
//   nuestra en Supabase y la de ellos).
// - Las llamadas son asíncronas: esto solo confirma que Talkyria la
//   aceptó; el resultado final llega por su webhook — ver
//   talkyria-webhook.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';

const TALKYRIA_API_URL = process.env.TALKYRIA_API_URL || 'https://api.talkyria.com/api/v1';
const TALKYRIA_API_KEY = process.env.TALKYRIA_API_KEY;
const TALKYRIA_AGENT_ID = process.env.TALKYRIA_AGENT_ID;

export async function llamarTalkyria({ telefono, nombre, municipio, estado, externalId }) {
  if (!TALKYRIA_API_KEY) {
    console.warn('TALKYRIA_API_KEY no configurado — llamada omitida.');
    return { ok: false, motivo: 'no_configurado' };
  }
  if (!TALKYRIA_AGENT_ID) {
    console.warn('TALKYRIA_AGENT_ID no configurado — corre scripts/crear-agente-talkyria.mjs primero.');
    return { ok: false, motivo: 'agente_no_configurado' };
  }

  try {
    const res = await fetch(`${TALKYRIA_API_URL}/calls/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TALKYRIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        externalId,                    // idempotencia — mismo evento nunca dispara dos veces
        agentId: TALKYRIA_AGENT_ID,     // agente API-native, ya configurado como aviso-y-cuelga
        customer: {
          name: nombre,
          phone: telefono              // E.164, ej. +523001234567
        },
        customVariables: {
          cv_municipio: municipio,
          cv_estado: estado
        }
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // wrong_host es un caso especial: la propia API te dice a qué URL
      // reenviar la petición si te equivocaste de host.
      if (data.code === 'wrong_host' && data.correctUrl) {
        console.error(`Talkyria: host incorrecto, reintentando en ${data.correctUrl}`);
        const res2 = await fetch(data.correctUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TALKYRIA_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            externalId, agentId: TALKYRIA_AGENT_ID,
            customer: { name: nombre, phone: telefono },
            customVariables: { cv_municipio: municipio, cv_estado: estado }
          })
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok) return { ok: false, motivo: data2.code || 'error_api', detalle: data2.message };
        return { ok: true, orderId: data2.id || null };
      }
      console.error('Talkyria respondió con error:', data.code, data.message);
      return { ok: false, motivo: data.code || 'error_api', detalle: data.message };
    }

    // La documentación no publica un esquema propio de respuesta para
    // /calls/trigger — dado que todo en su sistema gira sobre "pedidos",
    // lo más probable es que regrese el Order creado/emparejado. La
    // llamada en sí (con su propio id) llega después por el webhook, así
    // que igual no dependemos de un id exacto aquí.
    return { ok: true, orderId: data.id || null };

  } catch (err) {
    console.error('Fallo al llamar a Talkyria:', err.message);
    return { ok: false, motivo: 'excepcion', detalle: err.message };
  }
}

// --- Verificación de firma del webhook entrante --------------------------
// Talkyria firma cada webhook con HMAC-SHA256 sobre el cuerpo crudo,
// en el header X-Talkyria-Signature.
export function verificarFirmaTalkyria(rawBody, firmaHeader, secret) {
  if (!firmaHeader || !secret) return false;
  const esperada = createHmac('sha256', secret).update(rawBody).digest('hex');
  const recibida = firmaHeader.replace(/^sha256=/, '');
  const bufEsperada = Buffer.from(esperada, 'hex');
  const bufRecibida = Buffer.from(recibida, 'hex');
  if (bufEsperada.length !== bufRecibida.length) return false;
  return timingSafeEqual(bufEsperada, bufRecibida);
}

// Traduce el evento granular de Talkyria (confirmado contra su doc) a un
// resultado corto para guardar y mostrar en el admin.
export function resultadoDesdeEvento(eventType) {
  const mapa = {
    'call.confirmed': 'confirmada',
    'call.cancelled': 'cancelada',
    'call.no_answer': 'no_contesto',
    'call.voicemail': 'buzon',
    'call.novelty': 'novedad',
    'call.needs_attention': 'requiere_atencion',
    'call.failed': 'error',
    'call.novelty_resolved': 'novedad_resuelta'
  };
  return mapa[eventType] || 'desconocido';
}
