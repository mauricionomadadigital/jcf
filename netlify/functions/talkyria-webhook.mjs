// netlify/functions/talkyria-webhook.mjs
// Talkyria llama aquí cuando una llamada termina (por defecto,
// suscritos a call.outcome_final = todos los resultados; el evento
// granular real viaja en el campo `eventType`). Verificamos la firma
// HMAC-SHA256 antes de confiar en el contenido, y actualizamos la fila
// de `llamadas` que se creó al disparar la llamada (emparejada por
// call_id, que viene en `call.id` según su esquema documentado).
//
// Configura esta URL en el panel de Talkyria → Webhooks (o por API,
// POST /webhooks):
//   <SITE_URL>/.netlify/functions/talkyria-webhook
// y copia el secret que te den a la variable de entorno
// TALKYRIA_WEBHOOK_SECRET en Netlify — el secret solo se muestra una
// vez al crear el webhook, no se puede volver a consultar.

import { verificarFirmaTalkyria, resultadoDesdeEvento } from './lib/talkyria.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TALKYRIA_WEBHOOK_SECRET = process.env.TALKYRIA_WEBHOOK_SECRET;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

// Intenta emparejar el webhook con la fila que se creó al disparar la
// llamada. Ideal: por `evento` (nuestro externalId, si el webhook lo
// trae de vuelta junto al pedido — su doc no publica el wrapper
// completo del webhook, solo el objeto `call`, así que probamos varios
// lugares razonables donde podría venir). Respaldo: por `call_id`, para
// cuando ya lo guardamos en un evento anterior de la misma llamada.
async function actualizarLlamadaPorWebhook(body, call, cambios) {
  const candidatoExternalId = body.order?.externalId || body.externalId || null;

  if (candidatoExternalId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/llamadas?evento=eq.${encodeURIComponent(candidatoExternalId)}`, {
      method: 'PATCH',
      headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ ...cambios, call_id: call.id })
    });
    if (res.ok) {
      const filas = await res.json();
      if (Array.isArray(filas) && filas.length > 0) return true;
    }
  }

  // Respaldo: por call_id, si ya lo teníamos de un evento anterior.
  const res2 = await fetch(`${SUPABASE_URL}/rest/v1/llamadas?call_id=eq.${encodeURIComponent(call.id)}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(cambios)
  });
  if (!res2.ok) throw new Error(await res2.text());
  const filas2 = await res2.json();
  return Array.isArray(filas2) && filas2.length > 0;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  // Hay que leer el cuerpo crudo (texto) para verificar la firma antes
  // de parsearlo — si lo parseamos primero y lo re-serializamos, la
  // firma ya no coincide byte a byte.
  const rawBody = await req.text();
  const firma = req.headers.get('x-talkyria-signature');

  if (!verificarFirmaTalkyria(rawBody, firma, TALKYRIA_WEBHOOK_SECRET)) {
    console.warn('Webhook de Talkyria con firma inválida o faltante — ignorado.');
    return new Response('OK', { status: 200 }); // 200 para no revelar el motivo, no reintenta.
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('OK', { status: 200 });
  }

  const eventType = body.eventType || req.headers.get('x-talkyria-event-type') || body.event;

  // call.novelty_resolved trae `novelty` en vez de `call` (solo llega si
  // se suscribe explícito, que no es nuestro caso) — lo ignoramos limpio.
  if (!body.call) {
    console.log('Webhook de Talkyria sin objeto call (probablemente novelty_resolved) — ignorado.');
    return new Response('OK', { status: 200 });
  }

  const call = body.call;
  if (!call.id) {
    console.warn('Webhook de Talkyria sin call.id:', rawBody.slice(0, 500));
    return new Response('OK', { status: 200 });
  }

  try {
    const encontrada = await actualizarLlamadaPorWebhook(body, call, {
      resultado: resultadoDesdeEvento(eventType),
      event_type: eventType,
      outcome: call.outcome || null,
      summary: call.summary || null,
      recording_url: call.recordingUrl || null,
      duracion_seg: call.durationSeconds ?? null
    });
    if (!encontrada) {
      console.warn(`Webhook de Talkyria (call.id=${call.id}) no encontró fila que actualizar — revisa el emparejamiento por externalId.`);
    }
  } catch (err) {
    console.error('Error actualizando llamada desde webhook Talkyria:', err.message);
    // Aun así respondemos 200: si el problema es nuestro, que no
    // reintente indefinidamente; queda el log para revisar a mano.
  }

  return new Response('OK', { status: 200 });
};
