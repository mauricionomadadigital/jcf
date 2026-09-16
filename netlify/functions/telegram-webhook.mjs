// netlify/functions/telegram-webhook.mjs
// Telegram llama aquí cada vez que alguien interactúa con el bot.
// Cuando alguien abre el link t.me/<bot>?start=<token>, Telegram manda
// un mensaje "/start <token>" — con eso vinculamos su chat_id real
// a la fila de `suscriptores` que se creó en el webhook de pago.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
      // Cualquier otro mensaje: recordatorio breve, sin exponer lógica interna.
      if (texto === '/start') {
        await enviarMensaje(chatId, 'Para vincular tu monitoreo, abre el link que te llegó por correo después de tu pago.');
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
      `✅ ¡Listo! Quedaste vinculado.\n\nEstamos monitoreando: ${suscriptor.municipio}, ${suscriptor.estado}\n\nTe avisaremos por aquí en cuanto abra.`
    );

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Error telegram-webhook:', err.message);
    // Siempre 200 para que Telegram no reintente indefinidamente el mismo update.
    return new Response('OK', { status: 200 });
  }
};
