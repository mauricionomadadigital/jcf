// netlify/functions/config-publica.mjs
// Versión pública y mínima de la configuración — solo lo que el
// panel del cliente necesita mostrar (URLs de tutoriales, frecuencias,
// precio VIP vigente y textos de oferta/escasez). Nunca
// expone registro_abierto ni las fechas del ciclo por aquí; eso sigue
// protegido detrás de ADMIN_PASSWORD en admin-api.mjs.

import { normalizarPrecio } from './lib/precio.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || null;

export default async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=*&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const data = await res.json();
    const fila = Array.isArray(data) && data[0] ? data[0] : {};
    return new Response(JSON.stringify({
      ok: true,
      video1_url: fila.video1_url || null,
      video2_url: fila.video2_url || null,
      vip_frecuencia_min: fila.vip_frecuencia_min || 10,
      free_frecuencia_min: fila.free_frecuencia_min || 120,
      // Para saber cuándo mostrar la encuesta de fin de ciclo — antes de
      // esta fecha se oculta, para no confundir a alguien que apenas se
      // registró.
      encuesta_fecha: fila.encuesta_fecha || null,
      periodo_fin: fila.periodo_fin || null,
      ...normalizarPrecio(fila),
      // Para el botón "Vincular Telegram" del panel.
      telegram_bot: TELEGRAM_BOT_USERNAME
    }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    });
  } catch {
    return new Response(JSON.stringify({ ok: true, video1_url: null, video2_url: null, vip_frecuencia_min: 10, free_frecuencia_min: 120, encuesta_fecha: null, periodo_fin: null, ...normalizarPrecio({}) }), { status: 200 });
  }
};
