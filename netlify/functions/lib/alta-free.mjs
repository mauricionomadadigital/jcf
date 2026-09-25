// netlify/functions/lib/alta-free.mjs
// Alta (o reactivación) de una cuenta Gratis. Es la ÚNICA puerta de
// entrada al servicio: tanto el registro con correo+contraseña
// (register-free.mjs) como el registro con Google (google-auth.mjs)
// terminan aquí. El VIP ya no se contrata al registrarse — se sube desde
// el panel a /checkout-vip.html, que no vuelve a pedir datos.

import { hashPassword, generarCodigoReferido } from './auth.mjs';
import { enviarCorreo, plantillaBienvenida } from './email.mjs';

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

export class CuentaActivaError extends Error {}

// password: texto plano, o null cuando la cuenta se crea con Google (en
// ese caso entra con Google, y puede fijar una contraseña después desde
// su panel si quiere). Devuelve la fila del suscriptor.
export async function altaFree({ email, estado, municipio, password, referredBy, nombre, telefono, telefonoPrefijo }) {
  telefonoPrefijo = telefonoPrefijo || '+52';
  const historial = await historialPorCorreo(email);
  if (historial.find(f => f.activo)) {
    throw new CuentaActivaError('Ese correo ya tiene una cuenta activa. Entra desde "Iniciar sesión".');
  }

  const filaPrevia = historial[0] || null;
  let suscriptor;

  if (filaPrevia) {
    // Ya tuvo cuenta antes (archivada al cerrar un ciclo) — se reactiva
    // la misma fila, así conserva su Telegram vinculado y su código de
    // referido.
    suscriptor = await actualizarFila(filaPrevia.id, {
      estado,
      municipio,
      activo: true,
      plan: 'free',
      password_hash: password ? hashPassword(password) : filaPrevia.password_hash,
      referred_by: filaPrevia.referred_by || referredBy,
      cycle_number: (filaPrevia.cycle_number || 1) + 1,
      nombre,
      phone: telefono || filaPrevia.phone || null,
      telefono_prefijo: telefono ? telefonoPrefijo : (filaPrevia.telefono_prefijo || '+52'),
      cambios_municipio_restantes: 2
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
        password_hash: password ? hashPassword(password) : null,
        referral_code: referralCode,
        referred_by: referredBy,
        cycle_number: 1,
        nombre,
        phone: telefono || null,
        telefono_prefijo: telefonoPrefijo
      })
    });
    if (!res.ok) throw new Error(await res.text());
    [suscriptor] = await res.json();
  }

  if (suscriptor.telegram_chat_id) {
    // Ya estaba vinculado desde antes — no hace falta pedirle que vuelva
    // a dar clic en ningún link de Telegram.
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

  return suscriptor;
}
