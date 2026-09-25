// netlify/functions/customer-auth.mjs
// Login del portal del cliente (correo + contraseña), sesión y
// recuperación de contraseña. Las cuentas se crean en webhook.mjs
// (plan VIP) o register-free.mjs (plan Gratis) — aquí solo se entra.

import {
  verifyPassword, hashPassword, crearSesion, borrarSesion,
  suscriptorDesdeToken, tokenDesdeRequest, generarTokenReset
} from './lib/auth.mjs';
import { enviarCorreo } from './lib/email.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-comercial.netlify.app';

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

function sinPassword(suscriptor) {
  if (!suscriptor) return suscriptor;
  const { password_hash, reset_token, ...resto } = suscriptor;
  // Las cuentas creadas con Google no tienen contraseña hasta que fijan
  // una desde el panel — el panel lo usa para no pedir "la actual".
  return { ...resto, tiene_password: !!password_hash };
}

async function marcarIntentoFallido(id, intentos) {
  await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ intentos_fallidos: intentos })
  });
}

async function buscarPorEmail(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'POST' && action === 'login') {
      const { email, password } = await req.json();
      const suscriptor = await buscarPorEmail((email || '').trim().toLowerCase());

      // No revelamos si el correo existe o no en el mensaje de error —
      // solo distinguimos el bloqueo cuando SÍ hay una cuenta con 5
      // intentos fallidos acumulados.
      if (suscriptor && (suscriptor.intentos_fallidos || 0) >= 5) {
        return json({ error: 'Demasiados intentos fallidos. Recupera tu contraseña para volver a entrar.', bloqueado: true }, 423);
      }

      if (!suscriptor || !verifyPassword(password || '', suscriptor.password_hash)) {
        if (suscriptor) {
          const intentos = (suscriptor.intentos_fallidos || 0) + 1;
          await marcarIntentoFallido(suscriptor.id, intentos);
          if (intentos >= 5) {
            return json({ error: 'Demasiados intentos fallidos. Recupera tu contraseña para volver a entrar.', bloqueado: true }, 423);
          }
          return json({ error: `Correo o contraseña incorrectos. Te quedan ${5 - intentos} intento(s).` }, 401);
        }
        return json({ error: 'Correo o contraseña incorrectos.' }, 401);
      }

      if (suscriptor.intentos_fallidos) await marcarIntentoFallido(suscriptor.id, 0);
      const token = await crearSesion(suscriptor.id);
      return json({ ok: true, token, suscriptor: sinPassword(suscriptor) });
    }

    if (req.method === 'POST' && action === 'logout') {
      const token = tokenDesdeRequest(req);
      if (token) await borrarSesion(token);
      return json({ ok: true });
    }

    if (req.method === 'GET' && action === 'me') {
      const suscriptor = await suscriptorDesdeToken(tokenDesdeRequest(req));
      if (!suscriptor) return json({ error: 'Sesión inválida o vencida.' }, 401);
      return json({ ok: true, suscriptor: sinPassword(suscriptor) });
    }

    if (req.method === 'POST' && action === 'olvide') {
      const { email } = await req.json();
      const suscriptor = await buscarPorEmail((email || '').trim().toLowerCase());
      // Respuesta idéntica exista o no la cuenta, para no filtrar qué
      // correos están registrados.
      if (suscriptor) {
        const token = generarTokenReset();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora
        await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${suscriptor.id}`, {
          method: 'PATCH',
          headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify({ reset_token: token, reset_token_expires: expires })
        });
        const link = `${SITE_URL}/?reset=${token}`;
        await enviarCorreo(
          suscriptor.email,
          'Recupera tu acceso a Monitor JCF',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a1220;color:#eef2f9;border-radius:14px;">
             <h2 style="color:#34d399;">Monitor JCF</h2>
             <p>Pediste recuperar tu contraseña. Este enlace es válido por 1 hora:</p>
             <p style="text-align:center;margin:22px 0;"><a href="${link}" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Elegir nueva contraseña</a></p>
             <p style="color:#9aa7bd;font-size:12px;">Si no fuiste tú, ignora este correo.</p>
           </div>`
        );
      }
      return json({ ok: true, mensaje: 'Si el correo está registrado, enviamos un enlace de recuperación.' });
    }

    if (req.method === 'POST' && action === 'resetear') {
      const { token, newPassword } = await req.json();
      if (!newPassword || newPassword.length < 8) return json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' }, 400);
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/suscriptores?reset_token=eq.${encodeURIComponent(token || '')}&select=id,reset_token_expires&limit=1`,
        { headers: headersSupabase() }
      );
      const data = await res.json();
      const fila = Array.isArray(data) && data[0] ? data[0] : null;
      if (!fila || new Date(fila.reset_token_expires).getTime() < Date.now()) {
        return json({ error: 'El enlace de recuperación no es válido o ya venció.' }, 400);
      }
      await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${fila.id}`, {
        method: 'PATCH',
        headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({ password_hash: hashPassword(newPassword), reset_token: null, reset_token_expires: null, intentos_fallidos: 0 })
      });
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);
  } catch (err) {
    console.error('Error customer-auth:', err.message);
    return json({ error: err.message }, 500);
  }
};
