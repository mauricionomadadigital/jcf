// netlify/functions/webhook.mjs
// Maneja notificaciones IPN/Webhook de MercadoPago. Al aprobarse un pago
// VIP, da de alta (o renueva el ciclo de) al suscriptor, le genera su
// código de referido y le manda el link de Telegram por correo.

import { generarCodigoReferido } from './lib/auth.mjs';
import { enviarCorreo, plantillaBienvenida } from './lib/email.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function getPaymentData(paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Error obteniendo pago ${paymentId}: ${res.status}`);
  return res.json();
}

async function paymentAlreadyProcessed(paymentId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?payment_id=eq.${paymentId}&select=id&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

// Si el mismo correo ya fue VIP antes (ciclo previo), este pago es una
// renovación: hereda cycle_number+1 y el descuento se limpia (ya se cobró).
async function ultimoCicloDelCorreo(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&plan=eq.vip&select=cycle_number&order=created_at.desc&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0].cycle_number : 0;
}

async function crearSuscriptorVip({ email, estado, municipio, paymentId, phone, passwordHash, referredBy, monto }) {
  const cicloAnterior = await ultimoCicloDelCorreo(email);
  const referralCode = await generarCodigoReferido();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({
      email,
      estado,
      municipio,
      activo: true,
      payment_id: String(paymentId),
      plan: 'vip',
      phone: phone || null,
      password_hash: passwordHash || null,
      referral_code: referralCode,
      referred_by: referredBy || null,
      cycle_number: cicloAnterior + 1,
      discount_percent: 0,
      monto: monto || null,
      call_enabled: !!phone,
      vip_started_at: new Date().toISOString()
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Error guardando suscriptor en Supabase: ${err}`);
  }
  const [row] = await res.json();
  return row;
}

async function processPayment(paymentId) {
  console.log(`Procesando pago: ${paymentId}`);

  const alreadyDone = await paymentAlreadyProcessed(paymentId);
  if (alreadyDone) {
    console.log(`Pago ${paymentId} ya procesado — ignorando`);
    return { ok: true, skipped: true };
  }

  const payment = await getPaymentData(paymentId);
  console.log(`Pago ${paymentId}: status=${payment.status}, email=${payment.payer?.email}`);

  if (payment.status !== 'approved') {
    console.log(`Pago ${paymentId} no aprobado: ${payment.status}`);
    return { ok: true, status: payment.status };
  }

  const meta = payment.metadata || {};
  const email = payment.payer?.email || meta.email;
  const estado = meta.estado;
  const municipio = meta.municipio;

  if (!email || !estado || !municipio) {
    throw new Error('Faltan datos (email/estado/municipio) en el pago — revisa el metadata enviado por create-preference.');
  }

  const suscriptor = await crearSuscriptorVip({
    email, estado, municipio, paymentId,
    phone: meta.phone,
    passwordHash: meta.password_hash,
    referredBy: meta.referred_by,
    monto: payment.transaction_amount
  });

  const telegramLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${suscriptor.telegram_token}`;
  await enviarCorreo(
    email,
    '✅ Tu monitoreo VIP de JCF ya está activo',
    plantillaBienvenida({ plan: 'vip', municipio, estado, telegramLink })
  );

  console.log(`✅ Suscriptor VIP creado: ${email} — ${municipio}, ${estado}`);
  return { ok: true, email, estado, municipio };
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const topic = url.searchParams.get('topic');
    const id = url.searchParams.get('id');
    if (topic && id) console.log(`IPN GET test: topic=${topic}, id=${id}`);
    return new Response('OK', { status: 200 });
  }

  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  try {
    let paymentId = null;
    let topic = null;

    const topicParam = url.searchParams.get('topic');
    const idParam = url.searchParams.get('id');
    if (topicParam && idParam) {
      topic = topicParam;
      paymentId = idParam;
      console.log(`IPN recibido: topic=${topic}, id=${paymentId}`);
    }

    if (!paymentId) {
      try {
        const body = await req.json();
        console.log('Webhook recibido:', JSON.stringify(body));
        if (body.type === 'payment' && body.data?.id) {
          topic = 'payment';
          paymentId = body.data.id;
        }
      } catch {
        console.warn('Body no es JSON válido');
      }
    }

    if (!paymentId || (topic !== 'payment' && topic !== 'merchant_order')) {
      return new Response('OK - ignored', { status: 200 });
    }

    if (topic === 'merchant_order') {
      const res = await fetch(`https://api.mercadopago.com/merchant_orders/${paymentId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const order = await res.json();
      const payments = (order.payments || []).filter(p => p.status === 'approved');
      if (payments.length === 0) {
        return new Response('OK - no approved payments in order', { status: 200 });
      }
      paymentId = payments[0].id;
    }

    const result = await processPayment(paymentId);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Error webhook:', err.message);
    // Siempre 200 para que MercadoPago no reintente indefinidamente
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
};
