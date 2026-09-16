// netlify/functions/webhook.mjs
// Maneja notificaciones IPN/Webhook de MercadoPago. Al aprobarse un pago
// VIP, da de alta (o renueva el ciclo de) al suscriptor, le genera su
// código de referido y le manda el link de Telegram por correo.

import { generarCodigoReferido } from './lib/auth.mjs';
import { enviarCorreo, plantillaBienvenida, plantillaUpgradeVinculado } from './lib/email.mjs';

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

// Trae TODAS las filas de ese correo, más reciente primero. Con esto
// decidimos si el pago es una escalada (Gratis -> VIP), una renovación
// (VIP -> VIP) o un alta nueva, y heredamos lo que no debería perderse
// entre ciclos: el Telegram ya vinculado y el código de referido.
async function historialPorCorreo(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error('Error leyendo historial del correo: ' + (await res.text()));
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function desactivarFila(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ activo: false })
  });
}

async function actualizarFila(id, cambios) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(cambios)
  });
  if (!res.ok) throw new Error('Error actualizando suscriptor: ' + (await res.text()));
  const [row] = await res.json();
  return row;
}

async function insertarFila(datos) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(datos)
  });
  if (!res.ok) throw new Error(`Error guardando suscriptor en Supabase: ${await res.text()}`);
  const [row] = await res.json();
  return row;
}

// Da de alta el pago VIP sin duplicar identidad. Reglas:
//
// 1) Si la fila ACTIVA más reciente de este correo es plan=free, esto es
//    una escalada real: se ACTUALIZA esa misma fila a vip. Conserva su
//    id, telegram_token, telegram_chat_id y referral_code — si ya había
//    vinculado Telegram en Gratis, sigue vinculado, no hay que repetir
//    el paso.
// 2) En cualquier otro caso (alta nueva, o vuelve después de un ciclo
//    archivado) se inserta una fila nueva por ciclo — así el admin sigue
//    viendo el historial de pagos por separado — pero heredando
//    telegram_chat_id y referral_code de su fila más reciente si ya
//    existían, y desactivando cualquier fila que hubiera quedado activa
//    para ese correo, de modo que nunca haya dos filas activas a la vez.
async function altaOEscaladaVip({ email, estado, municipio, paymentId, phone, passwordHash, referredBy, monto, nombre, telefonoPrefijo }) {
  const historial = await historialPorCorreo(email);
  const filaActiva = historial.find(f => f.activo);
  const cicloMaxVip = historial.reduce((max, f) => (f.plan === 'vip' ? Math.max(max, f.cycle_number || 0) : max), 0);
  const filaConChat = historial.find(f => f.telegram_chat_id);
  const filaConReferido = historial.find(f => f.referral_code);

  const camposComunes = {
    payment_id: String(paymentId),
    plan: 'vip',
    estado,
    municipio,
    phone: phone || null,
    cycle_number: cicloMaxVip + 1,
    discount_percent: 0,
    monto: monto || null,
    call_enabled: !!phone,
    vip_started_at: new Date().toISOString(),
    activo: true
  };

  if (filaActiva && filaActiva.plan === 'free') {
    // Escalada real de una cuenta ya existente — nunca se le pide de
    // nuevo la contraseña, así que si no llegó una nueva (passwordHash
    // undefined) se conserva la que ya tenía en vez de borrarla.
    const row = await actualizarFila(filaActiva.id, {
      ...camposComunes,
      password_hash: passwordHash || filaActiva.password_hash,
      nombre: nombre || filaActiva.nombre,
      telefono_prefijo: telefonoPrefijo || filaActiva.telefono_prefijo,
      referred_by: filaActiva.referred_by || referredBy || null
    });
    return { row, yaVinculado: !!row.telegram_chat_id };
  }

  if (filaActiva) await desactivarFila(filaActiva.id);

  const row = await insertarFila({
    email,
    ...camposComunes,
    password_hash: passwordHash || null,
    nombre: nombre || null,
    telefono_prefijo: telefonoPrefijo || '+52',
    referral_code: filaConReferido?.referral_code || await generarCodigoReferido(),
    referred_by: filaConReferido?.referred_by || referredBy || null,
    telegram_chat_id: filaConChat?.telegram_chat_id || null
  });
  return { row, yaVinculado: !!row.telegram_chat_id };
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

  const { row: suscriptor, yaVinculado } = await altaOEscaladaVip({
    email, estado, municipio, paymentId,
    phone: meta.phone,
    passwordHash: meta.password_hash,
    referredBy: meta.referred_by,
    nombre: meta.nombre,
    telefonoPrefijo: meta.telefono_prefijo,
    monto: payment.transaction_amount
  });

  if (yaVinculado) {
    await enviarCorreo(
      email,
      '✅ Tu plan VIP de Monitor JCF ya está activo',
      plantillaUpgradeVinculado({ municipio, estado })
    );
  } else {
    const telegramLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${suscriptor.telegram_token}`;
    await enviarCorreo(
      email,
      '✅ Tu monitoreo VIP de JCF ya está activo',
      plantillaBienvenida({ plan: 'vip', municipio, estado, telegramLink })
    );
  }

  console.log(`✅ Suscriptor VIP: ${email} — ${municipio}, ${estado}`);
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
