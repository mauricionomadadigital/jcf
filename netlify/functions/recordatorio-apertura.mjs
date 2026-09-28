// netlify/functions/recordatorio-apertura.mjs
// Corre una vez al día. Mientras configuracion.fecha_estimada_apertura
// esté en el futuro, manda a TODOS los suscriptores activos (Gratis y
// VIP) un recordatorio de cuenta regresiva con la lista de documentos
// que van a pedir el día de la apertura, un link para darse de baja, y
// — solo a Gratis — una invitación a subir a VIP.
//
// El texto es exactamente lo que se pidió, editable en TEXTO_TELEGRAM /
// TEXTO_CORREO_HTML de este mismo archivo — ver MENSAJES-MONITOR-JCF.md
// para la lista completa de mensajes del sistema en un solo lugar.

import { getStore } from '@netlify/blobs';
import { registrarFallo } from './lib/fallos.mjs';
import { normalizarPrecio, formatoMxn } from './lib/precio.mjs';
import { cargarFlujo } from './lib/flujo.mjs';
import { CONSTRUCTORES, enviarEstacion, volcarEnvios } from './lib/flujo-mensajes.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function leerConfiguracion() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=*&limit=1`, { headers: headersSupabase() });
  const data = await res.json();
  return data && data[0] ? data[0] : null;
}

async function leerSuscriptoresActivos() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&select=id,email,estado,municipio,plan,telegram_chat_id,telegram_enabled,email_enabled,telegram_token`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error('No se pudieron leer los suscriptores: ' + (await res.text()));
  return res.json();
}

// Estación 4 del flujo (Admin > Flujo): el mensaje lo arma
// CONSTRUCTORES.cuenta_regresiva (lib/flujo-mensajes.mjs).

export default async () => {
  try {
    const config = await leerConfiguracion();
    const hoy = new Date().toISOString().slice(0, 10);

    if (!config || !config.fecha_estimada_apertura || hoy >= config.fecha_estimada_apertura) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Sin fecha de apertura configurada, o ya llegó — sin recordatorio.' }));
    }

    const flujo = await cargarFlujo();
    if (!flujo.activo('cuenta_regresiva')) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Estación "Cuenta regresiva" apagada en Admin > Flujo.' }));
    }

    const store = getStore('jcf-nacional');
    const yaEnviadoHoy = await store.get('recordatorio_apertura_fecha', { type: 'text' });
    if (yaEnviadoHoy === hoy) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Ya se mandó el recordatorio de hoy.' }));
    }

    const dias = Math.ceil((new Date(config.fecha_estimada_apertura) - new Date(hoy)) / 86400000);
    const suscriptores = await leerSuscriptoresActivos();
    const precioTxt = formatoMxn(normalizarPrecio(config).vip_precio);

    let telegramEnviados = 0;
    let correoEnviados = 0;

    for (const s of suscriptores) {
      const r = await enviarEstacion('cuenta_regresiva', s, CONSTRUCTORES.cuenta_regresiva(flujo, s, { dias, precioTxt }));
      if (r.telegram) telegramEnviados++;
      if (r.correo) correoEnviados++;
    }
    await volcarEnvios();

    await store.set('recordatorio_apertura_fecha', hoy);

    return new Response(JSON.stringify({ ok: true, dias, revisados: suscriptores.length, telegramEnviados, correoEnviados }));
  } catch (err) {
    console.error('Error recordatorio-apertura:', err.message);
    await registrarFallo({ tipo: 'cron', origen: 'recordatorio-apertura', detalle: err.message });
    return new Response(JSON.stringify({ ok: false, error: err.message }));
  }
};

// Una vez al día, ~9am hora de Ciudad de México (UTC-6 en horario
// estándar, UTC-5 en horario de verano — 15:00 UTC es una hora razonable
// para ambos casos).
export const config = {
  schedule: '0 15 * * *'
};
