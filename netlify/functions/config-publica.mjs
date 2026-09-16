// netlify/functions/config-publica.mjs
// Versión pública y mínima de la configuración — solo lo que el
// panel del cliente necesita mostrar (URLs de tutoriales). Nunca
// expone registro_abierto ni las fechas del ciclo por aquí; eso sigue
// protegido detrás de ADMIN_PASSWORD en admin-api.mjs.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=video1_url,video2_url&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const data = await res.json();
    const fila = Array.isArray(data) && data[0] ? data[0] : {};
    return new Response(JSON.stringify({ ok: true, video1_url: fila.video1_url || null, video2_url: fila.video2_url || null }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
    });
  } catch {
    return new Response(JSON.stringify({ ok: true, video1_url: null, video2_url: null }), { status: 200 });
  }
};
