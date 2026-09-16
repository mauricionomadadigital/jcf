// netlify/functions/register-free.mjs
// Alta del plan Gratis: sin pago, revisión cada 2 horas. Crea la cuenta
// directo (correo + contraseña) y manda el mismo correo con el link de
// Telegram que recibe un VIP, solo que sin cobrar nada.

import { hashPassword, generarCodigoReferido } from './lib/auth.mjs';
import { enviarCorreo, plantillaBienvenida } from './lib/email.mjs';
import { registroEstaAbierto } from './lib/config.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function yaExisteCorreo(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let email, estado, municipio, password, referredBy;
  try {
    const body = await req.json();
    email = (body.email || '').trim().toLowerCase();
    estado = (body.estado || '').trim();
    municipio = (body.municipio || '').trim();
    password = body.password || '';
    referredBy = (body.referredBy || '').trim().toUpperCase() || null;
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido.' }), { status: 400 });
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
  if (!(await registroEstaAbierto())) {
    return new Response(JSON.stringify({ error: 'El registro está cerrado por ahora — vuelve a intentarlo más tarde.' }), { status: 403 });
  }

  try {
    if (await yaExisteCorreo(email)) {
      return new Response(JSON.stringify({ error: 'Ese correo ya tiene una cuenta. Entra desde "Iniciar sesión".' }), { status: 409 });
    }

    const referralCode = await generarCodigoReferido();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores`, {
      method: 'POST',
      headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({
        email,
        estado,
        municipio,
        activo: true,
        plan: 'free',
        password_hash: hashPassword(password),
        referral_code: referralCode,
        referred_by: referredBy,
        cycle_number: 1
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const [suscriptor] = await res.json();

    const telegramLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${suscriptor.telegram_token}`;
    await enviarCorreo(
      email,
      '✅ Tu monitoreo gratuito de JCF ya está activo',
      plantillaBienvenida({ plan: 'free', municipio, estado, telegramLink })
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Error register-free:', err.message);
    return new Response(JSON.stringify({ error: 'No se pudo crear tu cuenta gratuita: ' + err.message }), { status: 500 });
  }
};
