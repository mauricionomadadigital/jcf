// netlify/functions/webhook.mjs
// Maneja notificaciones IPN/Webhook de MercadoPago. Al aprobarse un pago
// VIP, da de alta (o renueva el ciclo de) al suscriptor, le genera su
// código de referido y le manda el link de Telegram por correo.

import { processPayment } from './lib/pagos.mjs';
import { registrarFallo } from './lib/fallos.mjs';
import { enviarTelegramTexto } from './lib/soporte.mjs';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID;

let paymentIdGlobal = null;

export default async (req) => {
  paymentIdGlobal = null;
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

    paymentIdGlobal = paymentId;
    const result = await processPayment(paymentId);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Error webhook:', err.message);
    // Un pago aprobado que no se aplica es grave: queda en Admin > Fallos y
    // se avisa al admin por Telegram para corregirlo a mano de inmediato.
    await registrarFallo({ tipo: 'pago', origen: 'webhook', detalle: `Pago ${paymentIdGlobal || '?'}: ${err.message}` });
    if (ADMIN_TELEGRAM_CHAT_ID) {
      await enviarTelegramTexto(ADMIN_TELEGRAM_CHAT_ID, `🚨 Pago de Mercado Pago NO aplicado\nPago: ${paymentIdGlobal || '?'}\nError: ${err.message}\n\nRevisa Admin > Fallos.`);
    }
    // 200 para que Mercado Pago no reintente en bucle
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
};
