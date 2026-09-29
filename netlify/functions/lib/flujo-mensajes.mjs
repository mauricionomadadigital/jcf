// netlify/functions/lib/flujo-mensajes.mjs
// Un CONSTRUCTOR por estación del flujo: arma el mensaje exacto (Telegram
// y/o correo) para un suscriptor, con los textos de Admin > Flujo. Lo usan
// los envíos automáticos (crons, webhooks, alta) y el "Disparar ahora"
// manual, así ambos mandan siempre lo mismo.
//
// enviarEstacion() entrega por los canales que tenga el cliente y anota
// cada envío en un búfer; volcarEnvios() lo guarda en flujo_envios de un
// jalón (una sola petición) para los contadores de Admin > Flujo.

import { textoAHtml } from './flujo.mjs';
import { enviarCorreo, plantillaBienvenida, plantillaUpgradeVinculado } from './email.mjs';
import { enviarTelegram } from './dtmlp.mjs';
import { generarTokenReset } from './auth.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';
const LINK_VIP = `${SITE_URL}/checkout-vip.html`;
const LINK_SOPORTE = `${SITE_URL}/panel.html#soporte`;

const cajaCorreo = (contenido) => `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      ${contenido}
    </div>`;
const bajaLink = (s) => `${SITE_URL}/.netlify/functions/baja?token=${s.telegram_token}`;
// Link del bot para CORREOS: pasa por ir-telegram.mjs, que anota que el
// cliente abrió su correo (línea de tiempo del panel) y luego lo manda al bot.
export const linkTelegram = (s) => `${SITE_URL}/.netlify/functions/ir-telegram?t=${s.telegram_token}`;

function lineaSoporte(f, s) {
  return s.plan === 'vip' ? '\n\n' + f.texto('apertura', 'extra_vip', { link_soporte: LINK_SOPORTE }) : '';
}

// Cada constructor: (flujo, suscriptor, extra) => { telegram?, correo?: { asunto, html } }
export const CONSTRUCTORES = {
  bienvenida_gratis(f, s) {
    const v = { nombre: s.nombre || '', municipio: s.municipio, estado: s.estado };
    const asunto = f.texto('bienvenida_gratis', 'asunto', v);
    if (s.telegram_chat_id) {
      // Reactivación con Telegram ya vinculado: no hace falta el botón.
      return { correo: { asunto, html: cajaCorreo(`
        <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
        <p style="color:#9aa7bd;">¡Listo! Tu cuenta está activa y tu Telegram ya está vinculado — no hace falta hacer nada más.</p>
        <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
          <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
          <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${s.municipio}</p>
          <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
          <p style="margin:0;font-size:16px;">${s.estado}</p>
        </div>`) } };
    }
    return { correo: { asunto, html: plantillaBienvenida({
      plan: 'free', municipio: s.municipio, estado: s.estado, telegramLink: linkTelegram(s),
      intro: f.texto('bienvenida_gratis', 'intro', v), paso: f.texto('bienvenida_gratis', 'paso', v)
    }) } };
  },

  telegram_vinculado(f, s) {
    const v = { municipio: s.municipio, estado: s.estado };
    return { telegram: f.texto('telegram_vinculado', 'texto', v) + (s.plan === 'vip' ? '\n\n' + f.texto('telegram_vinculado', 'extra_vip', v) : '') };
  },

  seguimos_vigilando(f, s, { hora }) {
    return { telegram: f.texto('seguimos_vigilando', 'texto', { municipio: s.municipio, estado: s.estado, hora }) };
  },

  cuenta_regresiva(f, s, { dias, precioTxt }) {
    const esFree = s.plan !== 'vip';
    const v = { faltan_dias: `${dias} día${dias === 1 ? '' : 's'}`, municipio: s.municipio, estado: s.estado, precio: precioTxt, link_vip: LINK_VIP };
    const base = f.texto('cuenta_regresiva', 'texto', v);
    const upsell = esFree ? f.texto('cuenta_regresiva', 'upsell', v) : '';
    return {
      telegram: `${base}${upsell ? '\n\n' + upsell : ''}\n\nSi no quieres recibir más recordatorios como este, date de baja aquí: ${bajaLink(s)}`,
      correo: { asunto: f.texto('cuenta_regresiva', 'asunto', v), html: cajaCorreo(`
        <h1 style="color:#34d399;margin-bottom:8px;">⏳ Faltan ${v.faltan_dias}</h1>
        <div style="background:#101c30;border-radius:12px;padding:20px;margin:16px 0;border:1px solid rgba(52,211,153,0.25);">
          <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${s.municipio}</p>
          <p style="margin:0;font-size:16px;">${s.estado}</p>
        </div>
        <p style="color:#dbe4f0;line-height:1.55;">${textoAHtml(base)}</p>
        ${upsell ? `<p style="background:#101c30;border-radius:10px;padding:14px;border:1px solid rgba(52,211,153,0.2);">${textoAHtml(upsell)}</p>` : ''}
        <p style="color:#9aa7bd;font-size:12px;margin-top:20px;">Si no quieres recibir más recordatorios como este, <a href="${bajaLink(s)}" style="color:#9aa7bd;">date de baja aquí</a>.</p>`) }
    };
  },

  apertura(f, s, { municipio, estado }) {
    const v = { municipio: municipio || s.municipio, estado: estado || s.estado };
    return {
      telegram: f.texto('apertura', 'texto', v) + lineaSoporte(f, s),
      correo: { asunto: f.texto('apertura', 'asunto', v), html: cajaCorreo(`
        <h2 style="color:#34d399;">¡${v.municipio} está abierto!</h2>
        <p>${textoAHtml(f.texto('apertura', 'correo', v))}</p>
        <p style="text-align:center;margin:20px 0;"><a href="https://jovenesconstruyendoelfuturo.stps.gob.mx/" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Ir a la plataforma oficial</a></p>`) }
    };
  },

  recordatorio_vip(f, s, { n, total, municipio, estado }) {
    const v = { n, total, municipio: municipio || s.municipio, estado: estado || s.estado };
    return {
      telegram: f.texto('recordatorio_vip', 'texto', v) + lineaSoporte(f, s),
      correo: { asunto: f.texto('recordatorio_vip', 'asunto', v), html: cajaCorreo(`
        <h2 style="color:#34d399;">¡${v.municipio} sigue abierto!</h2>
        <p>${textoAHtml(f.texto('recordatorio_vip', 'correo', v))}</p>
        <p style="text-align:center;margin:20px 0;"><a href="https://jovenesconstruyendoelfuturo.stps.gob.mx/" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Ir a la plataforma oficial</a></p>`) }
    };
  },

  cambio_estado(f, s, { municipio, estado, estadoNuevo }) {
    return { telegram: f.texto('cambio_estado', 'texto', { municipio: municipio || s.municipio, estado: estado || s.estado, estado_nuevo: estadoNuevo }) + lineaSoporte(f, s) };
  },

  pago_aprobado(f, s) {
    const v = { nombre: s.nombre || '', municipio: s.municipio, estado: s.estado };
    if (s.telegram_chat_id) {
      return { correo: { asunto: f.texto('pago_aprobado', 'asunto_vinculado', v), html: plantillaUpgradeVinculado({ municipio: s.municipio, estado: s.estado, intro: f.texto('pago_aprobado', 'intro_vinculado', v) }) } };
    }
    return { correo: { asunto: f.texto('pago_aprobado', 'asunto_nuevo', v), html: plantillaBienvenida({ plan: 'vip', municipio: s.municipio, estado: s.estado, telegramLink: linkTelegram(s), intro: f.texto('pago_aprobado', 'intro_nuevo', v) }) } };
  },

  vencimiento_vip(f, s, { precioTxt }) {
    // Mismo porcentaje que se asignará al cerrar el periodo.
    const v = { nombre: s.nombre || '', municipio: s.municipio, estado: s.estado, precio: precioTxt, link_vip: LINK_VIP, descuento: (s.cycle_number || 1) >= 2 ? '70%' : '50%' };
    const texto = f.texto('vencimiento_vip', 'texto', v);
    return {
      telegram: texto,
      correo: { asunto: f.texto('vencimiento_vip', 'asunto', v), html: cajaCorreo(`
        <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
        <p style="color:#dbe4f0;line-height:1.55;">${textoAHtml(texto)}</p>
        <p style="text-align:center;margin:22px 0;"><a href="${LINK_VIP}" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Renovar VIP</a></p>`) }
    };
  },

  recuperar_password(f, s, { link }) {
    return { correo: { asunto: f.texto('recuperar_password', 'asunto', {}), html: cajaCorreo(`
      <h2 style="color:#34d399;">Monitor JCF</h2>
      <p>${textoAHtml(f.texto('recuperar_password', 'parrafo', {}))}</p>
      <p style="text-align:center;margin:22px 0;"><a href="${link}" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Elegir nueva contraseña</a></p>
      <p style="color:#9aa7bd;font-size:12px;">Si no fuiste tú, ignora este correo.</p>`) } };
  }
};

// --- Envío + registro ----------------------------------------------------------
const BUFER = [];

// opciones.forzar: ignora las preferencias de canal del cliente (correos
// transaccionales: bienvenida, pago, recuperar contraseña).
// opciones.soloCanal: 'telegram' | 'correo' para limitar el envío.
export async function enviarEstacion(clave, s, mensaje, { forzar = false, manual = false, soloCanal = null } = {}) {
  const r = { telegram: null, correo: null };
  if (mensaje.telegram && soloCanal !== 'correo' && s.telegram_chat_id && (forzar || s.telegram_enabled !== false)) {
    r.telegram = await enviarTelegram(TELEGRAM_BOT_TOKEN, s.telegram_chat_id, mensaje.telegram);
    BUFER.push({ clave, suscriptor_id: s.id || null, canal: 'telegram', ok: !!r.telegram, manual });
  }
  if (mensaje.correo && soloCanal !== 'telegram' && s.email && (forzar || s.email_enabled !== false)) {
    r.correo = await enviarCorreo(s.email, mensaje.correo.asunto, mensaje.correo.html);
    BUFER.push({ clave, suscriptor_id: s.id || null, canal: 'correo', ok: !!r.correo, manual });
  }
  return r;
}

// Guarda lo acumulado en flujo_envios. Nunca lanza: los contadores son
// secundarios frente al envío en sí (y sql/010 podría no estar aún).
export async function volcarEnvios() {
  if (!BUFER.length) return;
  const lote = BUFER.splice(0, BUFER.length);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/flujo_envios`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(lote)
    });
  } catch (err) { console.error('No se pudo registrar envíos del flujo:', err.message); }
}

// Recuperar contraseña: genera el token de 1 hora y arma el link.
export async function prepararRecuperacion(s) {
  const token = generarTokenReset();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${s.id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ reset_token: token, reset_token_expires: expires })
  });
  if (!res.ok) throw new Error('No se pudo generar el link de recuperación.');
  return { link: `${SITE_URL}/?reset=${token}` };
}
