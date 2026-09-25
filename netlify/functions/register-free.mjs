// netlify/functions/register-free.mjs
// Alta del plan Gratis con correo + contraseña: sin pago, revisión más
// espaciada que VIP (configurable en el panel admin, ver
// check-jcf-nacional.mjs). Recibe Telegram y correo igual que VIP; lo
// que no incluye es la llamada automática, exclusiva de VIP. La lógica
// de alta/reactivación vive en lib/alta-free.mjs, compartida con el
// registro con Google (google-auth.mjs).

import { altaFree, CuentaActivaError } from './lib/alta-free.mjs';
import { registroEstaAbierto } from './lib/config.mjs';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let email, estado, municipio, password, referredBy, nombre, telefono, telefonoPrefijo;
  try {
    const body = await req.json();
    email = (body.email || '').trim().toLowerCase();
    estado = (body.estado || '').trim();
    municipio = (body.municipio || '').trim();
    password = body.password || '';
    referredBy = (body.referredBy || '').trim().toUpperCase() || null;
    nombre = (body.nombre || '').trim();
    telefono = (body.telefono || '').trim();
    telefonoPrefijo = (body.telefonoPrefijo || '+52').trim();
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido.' }), { status: 400 });
  }

  if (!nombre) {
    return new Response(JSON.stringify({ error: 'Escribe tu nombre.' }), { status: 400 });
  }
  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Email inválido.' }), { status: 400 });
  }
  if (!estado || !municipio) {
    return new Response(JSON.stringify({ error: 'Debes elegir estado y municipio.' }), { status: 400 });
  }
  if (!password || password.length < 8) {
    return new Response(JSON.stringify({ error: 'La contraseña debe tener al menos 8 caracteres.' }), { status: 400 });
  }
  if (telefono && !/^\d{6,12}$/.test(telefono)) {
    return new Response(JSON.stringify({ error: 'Escribe un teléfono válido.' }), { status: 400 });
  }
  if (!(await registroEstaAbierto())) {
    return new Response(JSON.stringify({ error: 'El registro está cerrado por ahora — vuelve a intentarlo más tarde.' }), { status: 403 });
  }

  try {
    await altaFree({ email, estado, municipio, password, referredBy, nombre, telefono, telefonoPrefijo });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (err instanceof CuentaActivaError) {
      return new Response(JSON.stringify({ error: err.message }), { status: 409 });
    }
    console.error('Error register-free:', err.message);
    return new Response(JSON.stringify({ error: 'No se pudo crear tu cuenta gratuita: ' + err.message }), { status: 500 });
  }
};
