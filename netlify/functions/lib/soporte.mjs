// netlify/functions/lib/soporte.mjs
// Chat de soporte VIP <-> administrador (tabla mensajes_soporte).
// Lo usan: customer-api (el cliente escribe/lee desde su panel),
// telegram-webhook (el cliente VIP escribe directo al bot) y admin-api
// (el admin lee y contesta; la respuesta le llega al cliente por el bot).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Opcional: chat de Telegram del administrador, para avisarle al
// instante cuando un VIP escribe (debe haberle dado /start al bot).
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-v2.netlify.app';

export const MAX_MENSAJE_SOPORTE = 2000;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

export async function guardarMensaje({ suscriptorId, autor, canal, texto }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mensajes_soporte`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({
      suscriptor_id: suscriptorId,
      autor,
      canal,
      texto: texto.slice(0, MAX_MENSAJE_SOPORTE),
      // Lo que escribe el admin ya está "leído" por definición.
      leido: autor === 'admin'
    })
  });
  if (!res.ok) throw new Error('No se pudo guardar el mensaje: ' + (await res.text()));
  const [fila] = await res.json();
  return fila;
}

export async function hiloDe(suscriptorId, limite = 100) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mensajes_soporte?suscriptor_id=eq.${suscriptorId}&select=id,autor,canal,texto,leido,created_at&order=created_at.asc&limit=${limite}`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function enviarTelegramTexto(chatId, texto) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return { ok: false, description: 'sin chat' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: false })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

// Aviso inmediato al admin (si configuró su chat) de que un VIP escribió.
export async function avisarAdmin(suscriptor, texto, canal) {
  if (!ADMIN_TELEGRAM_CHAT_ID) return;
  await enviarTelegramTexto(
    ADMIN_TELEGRAM_CHAT_ID,
    `💬 Nuevo mensaje de soporte (${canal})\n${suscriptor.nombre || ''} <${suscriptor.email}>\n📍 ${suscriptor.municipio}, ${suscriptor.estado}\n\n${texto.slice(0, 1500)}\n\nResponde desde: ${SITE_URL}/admin.html`
  );
}

// Línea que se agrega a los avisos de monitoreo de VIP.
export function lineaSoporteVip() {
  return `\n\n💬 ¿Dudas, preguntas o algo no funciona? Escríbenos aquí mismo en este chat, o desde tu panel: ${SITE_URL}/panel.html#soporte`;
}
