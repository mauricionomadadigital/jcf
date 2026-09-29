// netlify/functions/lib/pagos.mjs
// Aplicar un pago VIP aprobado de Mercado Pago: identifica la CUENTA que
// compró (id del metadata o su correo, nunca el del pagador), la sube a
// VIP sobre su misma fila, guarda el pago en el historial (tabla pagos),
// manda el correo de VIP activo y avisa a Meta. Lo usan el webhook de
// Mercado Pago y el admin ("Aplicar pago" al conciliar).

import { generarCodigoReferido } from './auth.mjs';
import { enviarCompraMeta } from './meta-capi.mjs';
import { cargarFlujo } from './flujo.mjs';
import { CONSTRUCTORES, enviarEstacion, volcarEnvios } from './flujo-mensajes.mjs';
import { registrarFallo } from './fallos.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

export async function getPaymentData(paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Error obteniendo pago ${paymentId}: ${res.status}`);
  return res.json();
}

// Idempotencia: la tabla pagos (sql/012) guarda TODOS los pagos aplicados;
// suscriptores solo el último de cada persona, así que un aviso repetido
// de un pago viejo (tras una renovación) se volvería a aplicar si solo se
// revisara ahí. Si la tabla aún no existe, se cae a suscriptores.
async function paymentAlreadyProcessed(paymentId) {
  const enPagos = await fetch(`${SUPABASE_URL}/rest/v1/pagos?payment_id=eq.${encodeURIComponent(paymentId)}&select=id&limit=1`, { headers: headersSupabase() });
  if (enPagos.ok) {
    const filas = await enPagos.json();
    if (filas.length) return true;
  }
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?payment_id=eq.${paymentId}&select=id&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

// Una fila por pago aprobado (historial completo para el admin).
async function registrarPago({ paymentId, suscriptor, payment, meta }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pagos?on_conflict=payment_id`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({
      payment_id: String(paymentId),
      suscriptor_id: suscriptor.id,
      email: suscriptor.email,
      pagador_email: payment.payer?.email || null,
      monto: payment.transaction_amount ?? null,
      descuento_aplicado: Number(meta.descuento_aplicado) || 0,
      ciclo: suscriptor.cycle_number,
      estado: suscriptor.estado,
      municipio: suscriptor.municipio,
      metodo: payment.payment_type_id || payment.payment_method_id || null,
      vip_desde: suscriptor.vip_started_at
    })
  });
  if (!res.ok) await registrarFallo({ tipo: 'pago', origen: 'registrarPago', detalle: `Pago ${paymentId} aplicado pero no guardado en el historial: ${await res.text()}` });
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

// Da de alta el pago VIP sin duplicar identidad: UNA fila por persona.
// - Si ya tiene fila (Gratis, VIP que renueva, o archivada de un ciclo
//   anterior) se ACTUALIZA esa misma fila: conserva id, telegram_token,
//   telegram_chat_id y referral_code (que es único — antes se intentaba
//   insertar una fila nueva con el mismo código y la renovación fallaba,
//   dejando la cuenta desactivada).
// - Solo si nunca tuvo cuenta se inserta una fila nueva.
// `filaObjetivo` viene de create-preference (id de la cuenta logueada);
// si no, se busca por el correo de la CUENTA (nunca el de quien paga en
// Mercado Pago, que puede ser otra persona: mamá, tío...).
async function altaOEscaladaVip({ filaObjetivo, email, estado, municipio, paymentId, phone, passwordHash, referredBy, monto, nombre, telefonoPrefijo }) {
  const historial = filaObjetivo ? [filaObjetivo] : await historialPorCorreo(email);
  const fila = filaObjetivo || historial.find(f => f.activo) || historial[0] || null;
  const cicloMaxVip = historial.reduce((max, f) => (f.plan === 'vip' || f.payment_id ? Math.max(max, f.cycle_number || 0) : max), 0);

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
    activo: true,
    archivado_en: null
  };

  if (fila) {
    // Nunca se le vuelve a pedir la contraseña: si no llegó una nueva se
    // conserva la que ya tenía.
    const row = await actualizarFila(fila.id, {
      ...camposComunes,
      phone: phone || fila.phone || null,
      call_enabled: !!(phone || fila.phone),
      password_hash: passwordHash || fila.password_hash,
      nombre: nombre || fila.nombre,
      telefono_prefijo: telefonoPrefijo || fila.telefono_prefijo || '+52',
      referred_by: fila.referred_by || referredBy || null
    });
    return { row, yaVinculado: !!row.telegram_chat_id };
  }

  const row = await insertarFila({
    email,
    ...camposComunes,
    password_hash: passwordHash || null,
    nombre: nombre || null,
    telefono_prefijo: telefonoPrefijo || '+52',
    referral_code: await generarCodigoReferido(),
    referred_by: referredBy || null
  });
  return { row, yaVinculado: !!row.telegram_chat_id };
}

async function filaPorId(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${Number(id)}&select=*&limit=1`, { headers: headersSupabase() });
  if (!res.ok) return null;
  const [fila] = await res.json();
  return fila || null;
}

export async function processPayment(paymentId) {
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
  // La cuenta que sube a VIP es la del metadata (la que estaba logueada en
  // el checkout). El correo del pagador de Mercado Pago es solo el último
  // recurso: puede pagar otra persona.
  const filaObjetivo = meta.suscriptor_id ? await filaPorId(meta.suscriptor_id) : null;
  const email = filaObjetivo?.email || meta.email || payment.payer?.email;
  const estado = meta.estado || filaObjetivo?.estado;
  const municipio = meta.municipio || filaObjetivo?.municipio;

  if (!email || !estado || !municipio) {
    throw new Error('Faltan datos (email/estado/municipio) en el pago — revisa el metadata enviado por create-preference.');
  }

  const { row: suscriptor, yaVinculado } = await altaOEscaladaVip({
    filaObjetivo, email, estado, municipio, paymentId,
    phone: meta.phone,
    passwordHash: meta.password_hash,
    referredBy: meta.referred_by,
    nombre: meta.nombre,
    telefonoPrefijo: meta.telefono_prefijo,
    monto: payment.transaction_amount
  });
  await registrarPago({ paymentId, suscriptor, payment, meta });

  // Estación 8 del flujo (Admin > Flujo). Correo transaccional (forzar).
  const flujo = await cargarFlujo();
  await enviarEstacion('pago_aprobado', suscriptor, CONSTRUCTORES.pago_aprobado(flujo, suscriptor), { forzar: true });
  await volcarEnvios();

  // API de Conversiones de Meta: la compra cuenta aunque el cliente no
  // regrese a la página (OXXO/SPEI) — mismo event_id que el pixel.
  await enviarCompraMeta({
    paymentId, monto: payment.transaction_amount, suscriptor, email,
    telefono: suscriptor.phone || meta.phone, prefijo: suscriptor.telefono_prefijo || meta.telefono_prefijo,
    fbp: meta.meta_fbp, fbc: meta.meta_fbc, ip: meta.meta_ip, userAgent: meta.meta_ua
  });

  console.log(`✅ Suscriptor VIP: ${email} — ${municipio}, ${estado}`);
  return { ok: true, email, estado, municipio };
}
