// netlify/functions/create-preference.mjs
// Crea una preferencia de pago en MercadoPago para el plan VIP.
// (El plan Gratis no pasa por aquí — ver register-free.mjs.)

import { hashPassword, buscarSuscriptorPorEmail } from './lib/auth.mjs';
import { registroEstaAbierto } from './lib/config.mjs';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://CAMBIA-ESTO.netlify.app';
const PRECIO_VIP = 100.00;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!MP_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'MP_ACCESS_TOKEN no configurado en Netlify.' }), { status: 500 });
  }

  let email, estado, idedo, municipio, password, phone, referredBy;
  try {
    const body = await req.json();
    email = (body.email || '').trim().toLowerCase();
    estado = (body.estado || '').trim();
    idedo = body.idedo;
    municipio = (body.municipio || '').trim();
    password = body.password || '';
    phone = (body.phone || '').trim();
    referredBy = (body.referredBy || '').trim().toUpperCase() || null;
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido.' }), { status: 400 });
  }

  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Email inválido.' }), { status: 400 });
  }
  if (!estado || !municipio || idedo === undefined) {
    return new Response(JSON.stringify({ error: 'Debes elegir estado y municipio.' }), { status: 400 });
  }
  if (!password || password.length < 8) {
    return new Response(JSON.stringify({ error: 'La contraseña debe tener al menos 8 caracteres.' }), { status: 400 });
  }
  if (!(await registroEstaAbierto())) {
    return new Response(JSON.stringify({ error: 'El registro está cerrado por ahora — vuelve a intentarlo más tarde.' }), { status: 403 });
  }

  const passwordHash = hashPassword(password);
  const externalRef = `JCF-${Date.now()}-${email.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`;

  // Si ya tiene una cuenta con un descuento pendiente (por ejemplo,
  // contestó en la encuesta que no logró su lugar en un ciclo VIP
  // anterior), este es el único lugar donde de verdad se calcula lo que
  // se cobra — antes se guardaba el descuento pero nunca se aplicaba.
  const cuentaExistente = await buscarSuscriptorPorEmail(email);
  const descuento = cuentaExistente?.plan === 'vip' ? (cuentaExistente.discount_percent || 0) : 0;
  const precioFinal = Math.round(PRECIO_VIP * (1 - descuento / 100) * 100) / 100;

  const preference = {
    items: [
      {
        id: 'monitor-jcf-vip',
        title: `Monitor JCF VIP — ${municipio}, ${estado}`,
        description: descuento > 0
          ? `Revisión cada 5 minutos + correo y llamada cuando abra tu municipio, activo 14 días — ${descuento}% de descuento aplicado`
          : 'Revisión cada 5 minutos + correo y llamada cuando abra tu municipio, activo 14 días',
        quantity: 1,
        currency_id: 'MXN',
        unit_price: precioFinal
      }
    ],
    payer: { email },
    back_urls: {
      success: `${SITE_URL}?pago=exitoso`,
      failure: `${SITE_URL}?pago=fallido`,
      pending: `${SITE_URL}?pago=pendiente`
    },
    auto_return: 'approved',
    notification_url: `${SITE_URL}/.netlify/functions/webhook`,
    external_reference: externalRef,
    // Guardamos todo lo necesario para dar de alta al suscriptor aquí —
    // nunca la contraseña en texto plano, solo su hash.
    metadata: {
      email, estado, idedo, municipio, phone,
      password_hash: passwordHash,
      referred_by: referredBy,
      plan: 'vip',
      descuento_aplicado: descuento
    },
    statement_descriptor: 'MonitorJCF',
    expires: false
  };

  try {
    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': externalRef
      },
      body: JSON.stringify(preference)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Error MP:', JSON.stringify(data));
      return new Response(JSON.stringify({ error: data.message || 'Error al crear preferencia en MercadoPago.' }), { status: 502 });
    }

    return new Response(JSON.stringify({
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      preference_id: data.id,
      precio: precioFinal,
      descuento
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Error create-preference:', err.message);
    return new Response(JSON.stringify({ error: 'Error interno al conectar con MercadoPago.' }), { status: 500 });
  }
};
