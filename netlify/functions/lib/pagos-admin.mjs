// netlify/functions/lib/pagos-admin.mjs
// Herramientas del admin para pagos (Admin > Pagos):
// - forzarVip: un pago aprobado cuya cuenta no quedó VIP -> se sube a mano.
// - conciliarMercadoPago: compara los pagos aprobados en Mercado Pago de
//   este sitio contra el historial (tabla pagos) y lista los que faltan
//   (p. ej. el webhook falló ANTES de guardarlos).
// - aplicarPago: aplica uno de esos pagos con la misma lógica del webhook.

import { processPayment } from './pagos.mjs';
import { cargarFlujo } from './flujo.mjs';
import { CONSTRUCTORES, enviarEstacion, volcarEnvios } from './flujo-mensajes.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const VIP_DIAS = 14;
const SITE_URL = process.env.SITE_URL || 'https://monitorjcf.online';
const DOMINIOS_PROPIOS = [new URL(SITE_URL).host, 'monitorjcf.online', 'monitor-jcf-v2.netlify.app'];
const headers = (extra = {}) => ({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra });

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: headers(body ? { 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(await res.text());
  const texto = await res.text();
  return texto ? JSON.parse(texto) : null;
}

export async function forzarVip(paymentId) {
  const [pago] = await sb(`pagos?payment_id=eq.${encodeURIComponent(paymentId)}&select=*&limit=1`);
  if (!pago) throw new Error('Ese pago no está en el historial. Si está en Mercado Pago, usa "Conciliar" y "Aplicar pago".');
  if (!pago.suscriptor_id) throw new Error('El pago no está ligado a ninguna cuenta (se borró la cuenta).');
  const [cuenta] = await sb(`suscriptores?id=eq.${pago.suscriptor_id}&select=*&limit=1`);
  if (!cuenta) throw new Error('La cuenta de ese pago ya no existe.');

  // 14 días desde el pago; si ya pasaron, 14 días desde hoy (el cliente
  // pagó y no lo recibió: se le da su cobertura completa).
  const desdePago = pago.vip_desde || pago.created_at;
  const vigenteDesdePago = desdePago && Date.now() - new Date(desdePago).getTime() < VIP_DIAS * 86400000;
  const vipDesde = vigenteDesdePago ? desdePago : new Date().toISOString();

  const [actualizada] = await sb(`suscriptores?id=eq.${cuenta.id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { plan: 'vip', activo: true, archivado_en: null, vip_started_at: vipDesde, payment_id: String(paymentId), call_enabled: !!cuenta.phone, discount_percent: 0 }
  });
  await sb(`pagos?payment_id=eq.${encodeURIComponent(paymentId)}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { forzado_manual: true, vip_desde: vipDesde, nota: `VIP forzado por el admin el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC` }
  });
  // Mismo correo de "VIP activo" que el automático.
  const flujo = await cargarFlujo();
  await enviarEstacion('pago_aprobado', actualizada, CONSTRUCTORES.pago_aprobado(flujo, actualizada), { forzar: true, manual: true });
  await volcarEnvios();
  return { email: actualizada.email, vipDesde };
}

// Pagos aprobados de ESTE sitio en Mercado Pago (los que creó
// create-preference: external_reference "JCF-…" y aviso a este sitio) de
// los últimos N días.
async function pagosMercadoPago(dias = 60) {
  const desde = new Date(Date.now() - dias * 86400000).toISOString().replace('Z', '-00:00');
  const hasta = new Date().toISOString().replace('Z', '-00:00');
  const todos = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = `https://api.mercadopago.com/v1/payments/search?status=approved&sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(desde)}&end_date=${encodeURIComponent(hasta)}&limit=100&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } });
    if (!res.ok) throw new Error('Mercado Pago no respondió: ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    todos.push(...(data.results || []));
    if (!data.results || data.results.length < 100) break;
  }
  // Solo pagos de ESTE sitio: los avisos de Mercado Pago van a su webhook.
  // El sitio viejo (monitor-jcf-comercial) usa la misma cuenta de Mercado
  // Pago y el mismo prefijo "JCF-", así que el prefijo no basta.
  return todos.filter(p => String(p.external_reference || '').startsWith('JCF-') && DOMINIOS_PROPIOS.some(d => String(p.notification_url || '').includes(d)));
}

export async function conciliarMercadoPago() {
  const [enMp, enHistorial] = await Promise.all([pagosMercadoPago(), sb('pagos?select=payment_id&limit=5000')]);
  const registrados = new Set(enHistorial.map(p => String(p.payment_id)));
  const faltantes = enMp.filter(p => !registrados.has(String(p.id))).map(p => ({
    payment_id: String(p.id),
    fecha: p.date_approved || p.date_created,
    monto: p.transaction_amount,
    cuenta_email: p.metadata?.email || null,
    pagador_email: p.payer?.email || null,
    metodo: p.payment_type_id || null
  }));
  return { revisados: enMp.length, faltantes };
}

export async function aplicarPago(paymentId) {
  if (!/^\d{5,20}$/.test(String(paymentId))) throw new Error('Id de pago no válido.');
  const r = await processPayment(String(paymentId));
  if (r.skipped) throw new Error('Ese pago ya estaba aplicado.');
  if (r.status && r.status !== 'approved') throw new Error(`Mercado Pago dice que el pago está "${r.status}", no aprobado.`);
  return r;
}
