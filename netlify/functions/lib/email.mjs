// netlify/functions/lib/email.mjs
// Envío de correo vía Resend, factorizado para reutilizarse desde
// webhook.mjs (alta VIP) y register-free.mjs (alta Gratis).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-comercial.netlify.app';
// Nota temporal (igual que en el proyecto original): mientras se compra
// un dominio propio, se manda desde la dirección ya verificada en Resend.
const FROM = 'Monitor JCF <noreply@bookbuilderai.online>';

export async function enviarCorreo(to, subject, html) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY no configurado'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM, to, subject, html })
  });
  if (!res.ok) console.error('Error enviando email:', await res.text());
}

export function plantillaBienvenida({ plan, municipio, estado, telegramLink }) {
  const esVip = plan === 'vip';
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
      <p style="color:#9aa7bd;">${esVip ? '¡Gracias por tu pago!' : '¡Tu prueba gratuita ya quedó activa!'} Vamos a vigilar por ti:</p>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
        <p style="margin:0;font-size:16px;">${estado}</p>
        <p style="margin:12px 0 0;color:#9aa7bd;font-size:13px;">Plan</p>
        <p style="margin:0;font-size:16px;">${esVip ? '★ VIP — revisión cada 5 minutos + correo y llamada, activo 14 días' : 'Gratis — revisión cada 5 minutos por Telegram'}</p>
      </div>
      <p><strong>Un último paso:</strong> vincula tu Telegram para recibir la alerta.</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${telegramLink}" style="background:#34d399;color:#06281c;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Vincular mi Telegram</a>
      </p>
      <p style="color:#9aa7bd;font-size:13px;">Si el botón no funciona, abre este link: ${telegramLink}</p>
      <p style="color:#9aa7bd;font-size:13px;margin-top:18px;">Entra a tu panel cuando quieras en <a href="${SITE_URL}/" style="color:#34d399;">tu cuenta</a> con este correo y la contraseña que elegiste.</p>
    </div>
  `;
}

// Se usa cuando alguien escala de Gratis a VIP (o renueva) y su Telegram
// ya estaba vinculado desde antes — no tiene caso pedirle que vuelva a
// dar clic en un link que no necesita.
export function plantillaUpgradeVinculado({ municipio, estado }) {
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
      <p style="color:#9aa7bd;">¡Listo! Tu cuenta ya es <strong>VIP</strong> — no hace falta que hagas nada más en Telegram, ya está vinculado.</p>
      <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
        <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
        <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
        <p style="margin:0;font-size:16px;">${estado}</p>
        <p style="margin:12px 0 0;color:#9aa7bd;font-size:13px;">Plan</p>
        <p style="margin:0;font-size:16px;">★ VIP — revisión cada 5 minutos + correo y llamada, activo 14 días</p>
      </div>
      <p style="color:#9aa7bd;font-size:13px;margin-top:18px;">Entra a tu panel cuando quieras en <a href="${SITE_URL}/" style="color:#34d399;">tu cuenta</a> con este correo y tu contraseña.</p>
    </div>
  `;
}
