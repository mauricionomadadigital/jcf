// netlify/functions/register-free.mjs
// Alta del plan Gratis: sin pago, misma detección de 5 minutos que VIP
// por Telegram — lo que no incluye es correo ni llamada, exclusivos de
// VIP. Crea la cuenta directo (correo + contraseña), o reactiva una
// cuenta archivada de un ciclo anterior, y manda el mismo correo con el
// link de Telegram que recibe un VIP, solo que sin cobrar nada.

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

// Trae TODAS las filas de ese correo, más reciente primero — para saber
// si ya tiene una cuenta ACTIVA (entonces sí es un duplicado real) o si
// solo tiene una cuenta archivada de un ciclo anterior (entonces se
// reactiva esa misma fila en vez de bloquear el registro o crear una
// identidad nueva).
async function historialPorCorreo(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function actualizarFila(id, cambios) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(cambios)
  });
  if (!res.ok) throw new Error(await res.text());
  const [row] = await res.json();
  return row;
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
    const historial = await historialPorCorreo(email);
    const filaActiva = historial.find(f => f.activo);
    if (filaActiva) {
      return new Response(JSON.stringify({ error: 'Ese correo ya tiene una cuenta activa. Entra desde "Iniciar sesión".' }), { status: 409 });
    }

    const filaPrevia = historial[0] || null;
    let suscriptor;

    if (filaPrevia) {
      // Ya tuvo cuenta antes (archivada al cerrar un ciclo) — se
      // reactiva la misma fila en vez de crear una identidad nueva, así
      // conserva su Telegram vinculado y su código de referido.
      suscriptor = await actualizarFila(filaPrevia.id, {
        estado,
        municipio,
        activo: true,
        plan: 'free',
        password_hash: hashPassword(password),
        referred_by: filaPrevia.referred_by || referredBy,
        cycle_number: (filaPrevia.cycle_number || 1) + 1
      });
    } else {
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
      [suscriptor] = await res.json();
    }

    if (suscriptor.telegram_chat_id) {
      // Ya estaba vinculado desde antes — no hace falta pedirle que
      // vuelva a dar clic en ningún link de Telegram.
      await enviarCorreo(
        email,
        '✅ Tu monitoreo gratuito de JCF ya está activo',
        `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#0a1220;color:#eef2f9;border-radius:16px;">
          <h1 style="color:#34d399;margin-bottom:8px;">🔔 Monitor JCF</h1>
          <p style="color:#9aa7bd;">¡Listo! Tu cuenta quedó activa de nuevo — tu Telegram ya está vinculado, no hace falta hacer nada más.</p>
          <div style="background:#101c30;border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(52,211,153,0.25);">
            <p style="margin:0;color:#9aa7bd;font-size:13px;">Municipio</p>
            <p style="margin:0 0 10px;font-size:18px;font-weight:600;">${municipio}</p>
            <p style="margin:0;color:#9aa7bd;font-size:13px;">Estado</p>
            <p style="margin:0;font-size:16px;">${estado}</p>
          </div>
        </div>`
      );
    } else {
      const telegramLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${suscriptor.telegram_token}`;
      await enviarCorreo(
        email,
        '✅ Tu monitoreo gratuito de JCF ya está activo',
        plantillaBienvenida({ plan: 'free', municipio, estado, telegramLink })
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Error register-free:', err.message);
    return new Response(JSON.stringify({ error: 'No se pudo crear tu cuenta gratuita: ' + err.message }), { status: 500 });
  }
};
