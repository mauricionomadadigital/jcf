// netlify/functions/lib/fallos.mjs
// Bitácora de fallos silenciosos: crons que truenan, Telegram o correo
// que no se pudo entregar. Antes esto solo quedaba en console.warn/error
// (invisible salvo que revisaras los logs de Netlify a mano) — ahora
// también se guarda en la tabla `fallos_sistema`, visible desde el panel
// admin. Si guardar el fallo también falla, ya no hay más remedio que
// perderlo — nunca debe tumbar la función que lo está reportando.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function registrarFallo({ tipo, origen, detalle, suscriptorId }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/fallos_sistema`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        tipo,
        origen: origen || null,
        detalle: detalle ? String(detalle).slice(0, 2000) : null,
        suscriptor_id: suscriptorId || null
      })
    });
  } catch (err) {
    console.error('No se pudo registrar el fallo en fallos_sistema:', err.message);
  }
}
