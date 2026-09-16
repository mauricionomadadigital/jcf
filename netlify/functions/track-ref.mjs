// netlify/functions/track-ref.mjs
// Enlace corto de referido: /.netlify/functions/track-ref?code=ABC123
// Suma un clic al contador de ese código y redirige a la portada con
// ?ref=ABC123 para que el checkout capture quién refirió.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-comercial.netlify.app';

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').trim().toUpperCase();

  if (code) {
    try {
      // Upsert manual: intenta incrementar; si no existe la fila, la crea.
      const existente = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_clicks?code=eq.${encodeURIComponent(code)}&select=clics&limit=1`,
        { headers: headersSupabase() }
      );
      const filas = await existente.json();
      if (Array.isArray(filas) && filas.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/referral_clicks?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH',
          headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify({ clics: filas[0].clics + 1, updated_at: new Date().toISOString() })
        });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/referral_clicks`, {
          method: 'POST',
          headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify({ code, clics: 1 })
        });
      }
    } catch (err) {
      console.error('Error track-ref:', err.message);
      // No bloqueamos la redirección aunque falle el conteo.
    }
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL}/${code ? '?ref=' + encodeURIComponent(code) : ''}` }
  });
};
