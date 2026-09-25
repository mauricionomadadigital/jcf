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
import { enviarTelegram } from './lib/dtmlp.mjs';
import { enviarCorreo } from './lib/email.mjs';
import { registrarFallo } from './lib/fallos.mjs';
import { normalizarPrecio, formatoMxn } from './lib/precio.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-comercial.netlify.app';

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

function textoTelegram({ dias, municipio, estado, esFree, bajaLink, precioTxt }) {
  const base = `⏳ Faltan ${dias} día${dias === 1 ? '' : 's'} para que abra el registro de Jóvenes Construyendo el Futuro en ${municipio}, ${estado}.

📝 Haz tu preregistro en la plataforma oficial en cuanto esté disponible.
📄 Ten a la mano el día de la apertura: tu INE, tu CURP y un comprobante de domicilio ORIGINAL.
🤳 También te van a pedir tomarte una selfie ese día — prepárate.`;

  const upsell = esFree
    ? `\n\nActualmente tienes el plan Gratis. Con VIP (${precioTxt}, 14 días) además de Telegram recibes correo y una llamada automática en cuanto abra tu municipio — más posibilidades de enterarte a tiempo. Súbete aquí: ${SITE_URL}/checkout-vip.html`
    : '';

  return `${base}${upsell}\n\nSi no quieres recibir más recordatorios como este, date de baja aquí: ${bajaLink}`;
}

function htmlCorreo({ dias, municipio, estado, esFree, bajaLink, precioTxt }) {
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">⏳ Faltan ${dias} día${dias === 1 ? '' : 's'}</h1>
      <p style="color:#9aa7bd;">Para que abra el registro de Jóvenes Construyendo el Futuro en:</p>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:16px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
        <p style="margin:0;font-size:16px;">${estado}</p>
      </div>
      <p><strong>Antes de que abra:</strong></p>
      <ul style="color:#9aa7bd;padding-left:18px;">
        <li>Haz tu preregistro en la plataforma oficial en cuanto esté disponible.</li>
        <li>Ten a la mano tu <strong>INE</strong>, tu <strong>CURP</strong> y un <strong>comprobante de domicilio original</strong>.</li>
        <li>Te van a pedir tomarte una <strong>selfie</strong> el día de la apertura.</li>
      </ul>
      ${esFree ? `<p style="background:#101c30;border-radius:10px;padding:14px;border:1px solid rgba(52,211,153,0.2);">Actualmente tienes el plan <strong>Gratis</strong>. Con <strong>VIP</strong> (${precioTxt}, 14 días) además de Telegram recibes correo y una <strong>llamada automática</strong> en cuanto abra tu municipio. <a href="${SITE_URL}/checkout-vip.html" style="color:#34d399;">Súbete a VIP</a>.</p>` : ''}
      <p style="color:#9aa7bd;font-size:12px;margin-top:20px;">Si no quieres recibir más recordatorios como este, <a href="${bajaLink}" style="color:#9aa7bd;">date de baja aquí</a>.</p>
    </div>
  `;
}

export default async () => {
  try {
    const config = await leerConfiguracion();
    const hoy = new Date().toISOString().slice(0, 10);

    if (!config || !config.fecha_estimada_apertura || hoy >= config.fecha_estimada_apertura) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Sin fecha de apertura configurada, o ya llegó — sin recordatorio.' }));
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
      const bajaLink = `${SITE_URL}/.netlify/functions/baja?token=${s.telegram_token}`;
      const esFree = s.plan !== 'vip';

      if (s.telegram_enabled !== false && s.telegram_chat_id) {
        const ok = await enviarTelegram(
          TELEGRAM_BOT_TOKEN, s.telegram_chat_id,
          textoTelegram({ dias, municipio: s.municipio, estado: s.estado, esFree, bajaLink, precioTxt })
        );
        if (ok) telegramEnviados++;
      }
      if (s.email_enabled !== false && s.email) {
        await enviarCorreo(
          s.email,
          `⏳ Faltan ${dias} día${dias === 1 ? '' : 's'} para la apertura — Monitor JCF`,
          htmlCorreo({ dias, municipio: s.municipio, estado: s.estado, esFree, bajaLink, precioTxt })
        );
        correoEnviados++;
      }
    }

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
