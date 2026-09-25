// netlify/functions/telegram-webhook.mjs
// Telegram llama aquí cada vez que alguien interactúa con el bot.
// Cuando alguien abre el link t.me/<bot>?start=<token>, Telegram manda
// un mensaje "/start <token>" — con eso vinculamos su chat_id real
// a la fila de `suscriptores` que se creó en el webhook de pago.

import { guardarMensaje, avisarAdmin } from './lib/soporte.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-v2.netlify.app';

async function buscarPorChat(chatId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?telegram_chat_id=eq.${encodeURIComponent(String(chatId))}&activo=eq.true&select=*&order=created_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function enviarMensaje(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto })
  });
}

async function buscarPorToken(token) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?telegram_token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function vincularChatId(id, chatId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ telegram_chat_id: String(chatId) })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Error vinculando chat_id: ${err}`);
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  try {
    const update = await req.json();
    const msg = update.message;
    if (!msg || !msg.text) {
      return new Response('OK', { status: 200 });
    }

    const chatId = msg.chat.id;
    const texto = msg.text.trim();

    // Formato esperado: "/start <token>"
    const match = texto.match(/^\/start\s+(\S+)/);

    if (!match) {
      // Texto libre de alguien ya vinculado: si es VIP, es un mensaje de
      // soporte (le llega al admin en su panel); si es Gratis, se le
      // explica que el soporte directo es parte de VIP.
      if (!texto.startsWith('/')) {
        const cuenta = await buscarPorChat(chatId);
        if (cuenta && cuenta.plan === 'vip') {
          await guardarMensaje({ suscriptorId: cuenta.id, autor: 'cliente', canal: 'telegram', texto });
          await avisarAdmin(cuenta, texto, 'Telegram');
          await enviarMensaje(chatId, '✅ Recibimos tu mensaje. Te respondemos por aquí mismo en cuanto podamos.');
          return new Response('OK', { status: 200 });
        }
        if (cuenta) {
          await enviarMensaje(chatId, `El soporte directo por este chat es exclusivo del plan VIP. Si quieres subir a VIP: ${SITE_URL}/checkout-vip.html`);
          return new Response('OK', { status: 200 });
        }
      }
      if (texto === '/start') {
        await enviarMensaje(chatId, 'Para vincular tu monitoreo, abre el link que te llegó por correo al registrarte (revisa también spam), o el botón de Telegram en tu panel.');
      }
      return new Response('OK', { status: 200 });
    }

    const token = match[1];
    const suscriptor = await buscarPorToken(token);

    if (!suscriptor) {
      await enviarMensaje(chatId, 'No encontramos un registro con ese link. Si el problema sigue, escríbenos.');
      return new Response('OK', { status: 200 });
    }

    if (!suscriptor.activo) {
      await enviarMensaje(chatId, 'Tu suscripción ya no está activa. Si crees que es un error, contáctanos.');
      return new Response('OK', { status: 200 });
    }

    await vincularChatId(suscriptor.id, chatId);
    await enviarMensaje(
      chatId,
      `✅ ¡Listo! Quedaste vinculado.\n\nEstamos monitoreando: ${suscriptor.municipio}, ${suscriptor.estado}\n\nTe avisaremos por aquí en cuanto abra.` +
        (suscriptor.plan === 'vip' ? '\n\n💬 Como eres VIP, si tienes dudas o algo no funciona, escríbenos aquí mismo en este chat.' : '')
    );

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Error telegram-webhook:', err.message);
    // Siempre 200 para que Telegram no reintente indefinidamente el mismo update.
    return new Response('OK', { status: 200 });
  }
};
