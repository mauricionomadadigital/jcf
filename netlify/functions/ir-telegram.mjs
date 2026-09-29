// netlify/functions/ir-telegram.mjs
// El botón "Vincular mi Telegram" de los correos pasa por aquí: anota que
// el cliente abrió su correo (paso "Correo ✅" de la línea de tiempo del
// panel) y lo manda al bot con su código de vinculación. ?t=<telegram_token>

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';

const headers = (extra = {}) => ({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra });

export default async (req) => {
  const token = new URL(req.url).searchParams.get('t') || '';
  // Mismo formato que genera la base (uuid); cualquier otra cosa se ignora.
  if (!/^[0-9a-f-]{8,64}$/i.test(token)) {
    return new Response(null, { status: 302, headers: { Location: `${SITE_URL}/entrar.html` } });
  }
  try {
    // Solo la primera vez: la fecha de verificación no se sobrescribe.
    await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?telegram_token=eq.${encodeURIComponent(token)}&correo_verificado_at=is.null`, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ correo_verificado_at: new Date().toISOString() })
    });
  } catch (err) {
    console.error('ir-telegram: no se pudo anotar la verificación:', err.message); // no bloquea al cliente
  }
  return new Response(null, { status: 302, headers: { Location: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}` } });
};
