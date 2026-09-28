// netlify/functions/lib/meta-capi.mjs
// API de Conversiones de Meta (servidor -> Meta). Complementa al pixel
// del navegador (public/pixel.js): la compra VIP se reporta desde el
// webhook de Mercado Pago en cuanto el pago se aprueba, aunque el cliente
// ya no esté en la página (OXXO/SPEI se aprueban horas después) o tenga
// bloqueadores. Se usa el MISMO event_id que el navegador ('vip-<pago>')
// para que Meta cuente cada compra una sola vez.
//
// Correo y teléfono viajan solo como hash SHA-256 (así lo exige Meta);
// nunca en texto plano.

import { createHash } from 'node:crypto';
import { registrarFallo } from './fallos.mjs';

const META_PIXEL_ID = process.env.META_PIXEL_ID || '1456607546341278';
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN;
// Opcional: código de "Probar eventos" del Administrador de eventos, para
// ver los eventos del servidor en vivo sin contarlos como reales.
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');

function datosUsuario({ email, telefono, prefijo, externalId, fbp, fbc, ip, userAgent }) {
  const u = { country: [sha256('mx')] };
  if (email) u.em = [sha256(String(email).trim().toLowerCase())];
  const digitos = String(telefono || '').replace(/\D/g, '');
  if (digitos) u.ph = [sha256(String(prefijo || '+52').replace(/\D/g, '') + digitos)];
  if (externalId) u.external_id = [sha256(String(externalId))];
  if (fbp) u.fbp = fbp;
  if (fbc) u.fbc = fbc;
  if (ip) u.client_ip_address = ip;
  if (userAgent) u.client_user_agent = userAgent;
  return u;
}

// Nunca lanza: un fallo aquí no debe tumbar el alta VIP ni el webhook.
export async function enviarCompraMeta({ paymentId, monto, suscriptor, email, telefono, prefijo, fbp, fbc, ip, userAgent }) {
  if (!META_CAPI_TOKEN) return { ok: false, motivo: 'sin_token' };
  const cuerpo = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: `vip-${paymentId}`,
      action_source: 'website',
      event_source_url: `${SITE_URL}/checkout-vip.html`,
      user_data: datosUsuario({ email, telefono, prefijo, externalId: suscriptor?.id, fbp, fbc, ip, userAgent }),
      custom_data: {
        value: Number(monto) || 0,
        currency: 'MXN',
        content_name: 'VIP 14 días',
        content_type: 'product',
        content_ids: ['monitor-jcf-vip'],
        num_items: 1,
        order_id: String(paymentId)
      }
    }],
    ...(META_TEST_EVENT_CODE ? { test_event_code: META_TEST_EVENT_CODE } : {})
  };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_CAPI_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.events_received) {
      await registrarFallo({ tipo: 'meta', origen: 'enviarCompraMeta', detalle: `Pago ${paymentId}: ${JSON.stringify(data.error || data).slice(0, 500)}` });
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    await registrarFallo({ tipo: 'meta', origen: 'enviarCompraMeta', detalle: `Pago ${paymentId}: ${err.message}` });
    return { ok: false };
  }
}
