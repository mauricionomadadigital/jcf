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
import { cargarFlujo, textoAHtml } from './lib/flujo.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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

// Estación 4 del flujo (Admin > Flujo): el mismo texto editable sirve
// para Telegram y para el cuerpo del correo; a Gratis se le agrega la
// invitación a VIP. La línea de baja es fija (obligatoria).
function textoTelegram({ flujo, vars, esFree, bajaLink }) {
  const base = flujo.texto('cuenta_regresiva', 'texto', vars);
  const upsell = esFree ? '\n\n' + flujo.texto('cuenta_regresiva', 'upsell', vars) : '';
  return `${base}${upsell}\n\nSi no quieres recibir más recordatorios como este, date de baja aquí: ${bajaLink}`;
}

function htmlCorreo({ flujo, vars, esFree, bajaLink }) {
  const upsell = esFree
    ? `<p style="background:#101c30;border-radius:10px;padding:14px;border:1px solid rgba(52,211,153,0.2);">${textoAHtml(flujo.texto('cuenta_regresiva', 'upsell', vars))}</p>`
    : '';
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">⏳ Faltan ${vars.faltan_dias}</h1>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:16px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${vars.municipio}</p>
        <p style="margin:0;font-size:16px;">${vars.estado}</p>
      </div>
      <p style="color:#dbe4f0;line-height:1.55;">${textoAHtml(flujo.texto('cuenta_regresiva', 'texto', vars))}</p>
      ${upsell}
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
      const bajaLink = `${SITE_URL}/.netlify/functions/baja?token=${s.telegram_token}`;
      const esFree = s.plan !== 'vip';
      const vars = {
        faltan_dias: `${dias} día${dias === 1 ? '' : 's'}`, municipio: s.municipio, estado: s.estado,
        precio: precioTxt, link_vip: `${SITE_URL}/checkout-vip.html`
      };

      if (s.telegram_enabled !== false && s.telegram_chat_id) {
        const ok = await enviarTelegram(
          TELEGRAM_BOT_TOKEN, s.telegram_chat_id,
          textoTelegram({ flujo, vars, esFree, bajaLink })
        );
        if (ok) telegramEnviados++;
      }
      if (s.email_enabled !== false && s.email) {
        await enviarCorreo(
          s.email,
          flujo.texto('cuenta_regresiva', 'asunto', vars),
          htmlCorreo({ flujo, vars, esFree, bajaLink })
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
