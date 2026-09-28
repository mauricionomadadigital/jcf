// netlify/functions/lib/email.mjs
// Envío de correo vía Resend, factorizado para reutilizarse desde
// webhook.mjs (alta VIP) y register-free.mjs (alta Gratis).

import { registrarFallo } from './fallos.mjs';
import { textoAHtml } from './flujo.mjs';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';
// Dominio propio del proyecto, verificado en Resend (SPF, DKIM y DMARC
// en Netlify DNS). Remitente con nombre de marca = menos spam.
const FROM = 'Monitor JCF <avisos@monitorjcf.online>';
// Las respuestas llegan a un buzón real — un "noreply" sin reply-to
// resta confianza ante los filtros de spam.
const REPLY_TO = 'maurixcasas@gmail.com';

// Versión de texto plano del mismo correo. Un correo solo-HTML es una
// señal típica de spam; con las dos versiones Gmail confía más.
function htmlATexto(html) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `${txt.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function enviarCorreo(to, subject, html) {
  // Emojis al inicio del asunto también suman puntos de spam.
  subject = subject.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '');
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurado');
    await registrarFallo({ tipo: 'correo', origen: 'enviarCorreo', detalle: `RESEND_API_KEY no configurado (destinatario: ${to})` });
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM, to, subject, html, text: htmlATexto(html), reply_to: REPLY_TO })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Error enviando email:', err);
    await registrarFallo({ tipo: 'correo', origen: 'enviarCorreo', detalle: `Para ${to} — asunto "${subject}": ${err}` });
    return false;
  }
  return true;
}

// intro / paso: textos editables del flujo (Admin > Flujo), ya con sus
// variables reemplazadas. Sin ellos se usan los de siempre.
// --- Correos masivos (Admin > Mensajes > por correo) --------------------------
// Texto libre del admin -> HTML con el diseño de siempre, links clicables y
// un pie para apagar los correos desde el panel (no el link de baja, que
// borra la cuenta completa).
export function plantillaAviso({ texto }) {
  const cuerpo = textoAHtml(texto).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#34d399;">$1</a>');
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin:0 0 12px;">🔔 Monitor JCF</h1>
      <p style="color:#dbe4f0;line-height:1.6;">${cuerpo}</p>
      <p style="color:#6b7a90;font-size:11.5px;margin-top:26px;border-top:1px solid #1d2a3f;padding-top:12px;">
        Recibes este correo porque tienes una cuenta en Monitor JCF. Puedes apagar los correos desde
        <a href="${SITE_URL}/panel.html" style="color:#6b7a90;">tu panel</a> (Canales de aviso).
      </p>
    </div>`;
}

// Envío por lotes con la API batch de Resend (hasta 100 por petición;
// su límite es ~2 peticiones/seg). correos: [{ to, subject, html }].
// Devuelve cuántos se aceptaron y cuántos fallaron.
export async function enviarCorreosLote(correos) {
  let enviados = 0, fallidos = 0;
  if (!RESEND_API_KEY) return { enviados, fallidos: correos.length };
  for (let i = 0; i < correos.length; i += 100) {
    const lote = correos.slice(i, i + 100).map(c => ({ from: FROM, to: c.to, subject: c.subject, html: c.html, text: htmlATexto(c.html), reply_to: REPLY_TO }));
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(lote)
      });
      if (res.ok) enviados += lote.length;
      else {
        fallidos += lote.length;
        await registrarFallo({ tipo: 'correo', origen: 'enviarCorreosLote', detalle: `Lote de ${lote.length}: ${(await res.text()).slice(0, 500)}` });
      }
    } catch (err) {
      fallidos += lote.length;
      await registrarFallo({ tipo: 'correo', origen: 'enviarCorreosLote', detalle: err.message });
    }
    if (i + 100 < correos.length) await new Promise(r => setTimeout(r, 600));
  }
  return { enviados, fallidos };
}

export function plantillaBienvenida({ plan, municipio, estado, telegramLink, intro, paso }) {
  const esVip = plan === 'vip';
  const introHtml = intro ? textoAHtml(intro) : `${esVip ? '¡Gracias por tu pago!' : '¡Tu prueba gratuita ya quedó activa!'} Vamos a vigilar por ti:`;
  const pasoHtml = paso ? textoAHtml(paso) : '<strong>Un último paso:</strong> vincula tu Telegram para recibir la alerta.';
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
      <p style="color:#9aa7bd;">${introHtml}</p>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
        <p style="margin:0;font-size:16px;">${estado}</p>
        <p style="margin:12px 0 0;color:#9aa7bd;font-size:13px;">Plan</p>
        <p style="margin:0;font-size:16px;">${esVip ? '★ VIP — revisión frecuente + correo y llamada, activo 14 días' : 'Gratis — revisión periódica por Telegram'}</p>
      </div>
      <p>${pasoHtml}</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${telegramLink}" style="background:#34d399;color:#06281c;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Vincular mi Telegram</a>
      </p>
      <p style="color:#9aa7bd;font-size:13px;">Si el botón no funciona, abre este link: ${telegramLink}</p>
      <p style="color:#9aa7bd;font-size:13px;margin-top:18px;">Entra a tu panel cuando quieras en <a href="${SITE_URL}/entrar.html" style="color:#34d399;">tu cuenta</a> con este correo (con tu contraseña o con el botón de Google).</p>
    </div>
  `;
}

// Se usa cuando alguien escala de Gratis a VIP (o renueva) y su Telegram
// ya estaba vinculado desde antes — no tiene caso pedirle que vuelva a
// dar clic en un link que no necesita.
export function plantillaUpgradeVinculado({ municipio, estado, intro }) {
  const introHtml = intro ? textoAHtml(intro) : '¡Listo! Tu cuenta ya es <strong>VIP</strong> — no hace falta que hagas nada más en Telegram, ya está vinculado.';
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
      <p style="color:#9aa7bd;">${introHtml}</p>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
        <p style="margin:0;font-size:16px;">${estado}</p>
        <p style="margin:12px 0 0;color:#9aa7bd;font-size:13px;">Plan</p>
        <p style="margin:0;font-size:16px;">★ VIP — revisión frecuente + correo y llamada, activo 14 días</p>
      </div>
      <p style="color:#9aa7bd;font-size:13px;margin-top:18px;">Entra a tu panel cuando quieras en <a href="${SITE_URL}/entrar.html" style="color:#34d399;">tu cuenta</a> con este correo y tu contraseña.</p>
    </div>
  `;
}
