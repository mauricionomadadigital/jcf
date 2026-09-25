// netlify/functions/difusion-background.mjs
// Mensaje masivo por Telegram desde el panel admin, a clientes VIP o a
// clientes Gratis. Es una Background Function (sufijo -background):
// Netlify responde 202 de inmediato y esto sigue corriendo hasta 15 min,
// así no se corta aunque haya cientos de destinatarios. El avance queda
// en la tabla `difusiones`, que el admin consulta para ver el resultado.
//
// Solo a cuentas activas, con Telegram vinculado y sin Telegram apagado
// en sus canales. Telegram permite ~30 mensajes/seg por bot; aquí se
// manda ~20/seg para ir con margen.

import { enviarTelegramTexto } from './lib/soporte.mjs';
import { registrarFallo } from './lib/fallos.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PAUSA_MS = 50;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function actualizarDifusion(id, cambios) {
  await fetch(`${SUPABASE_URL}/rest/v1/difusiones?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(cambios)
  });
}

export default async (req) => {
  if (req.method !== 'POST') return;
  if (!ADMIN_PASSWORD || req.headers.get('x-admin-password') !== ADMIN_PASSWORD) return;

  let segmento, texto;
  try {
    const body = await req.json();
    segmento = body.segmento;
    texto = (body.texto || '').trim();
  } catch { return; }
  if (!['vip', 'free'].includes(segmento) || !texto || texto.length > 4000) return;

  const resDest = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&plan=eq.${segmento}&telegram_chat_id=not.is.null&select=id,telegram_chat_id,telegram_enabled`,
    { headers: headersSupabase() }
  );
  const destinatarios = (await resDest.json()).filter(s => s.telegram_enabled !== false);

  const resCrear = await fetch(`${SUPABASE_URL}/rest/v1/difusiones`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({ segmento, texto, destinatarios: destinatarios.length })
  });
  if (!resCrear.ok) {
    await registrarFallo({ tipo: 'difusion', origen: 'difusion-background', detalle: 'No se pudo crear la difusión: ' + (await resCrear.text()) });
    return;
  }
  const [difusion] = await resCrear.json();

  let enviados = 0;
  let fallidos = 0;
  const errores = new Map(); // descripción -> cuántas veces
  for (const s of destinatarios) {
    const r = await enviarTelegramTexto(s.telegram_chat_id, texto);
    if (r.ok) enviados++;
    else {
      fallidos++;
      errores.set(r.description, (errores.get(r.description) || 0) + 1);
    }
    // Avance visible en el admin cada 25 mensajes.
    if ((enviados + fallidos) % 25 === 0) await actualizarDifusion(difusion.id, { enviados, fallidos });
    await new Promise(r => setTimeout(r, PAUSA_MS));
  }

  await actualizarDifusion(difusion.id, { enviados, fallidos, estado: 'terminado', terminado_en: new Date().toISOString() });
  if (fallidos > 0) {
    // Un solo registro con el resumen — no uno por cliente que bloqueó el bot.
    const resumen = [...errores].map(([d, n]) => `${n}× ${d}`).join('; ');
    await registrarFallo({ tipo: 'difusion', origen: 'difusion-background', detalle: `Difusión #${difusion.id} (${segmento}): ${fallidos} sin entregar — ${resumen}` });
  }
};
