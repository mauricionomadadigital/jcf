// netlify/functions/google-auth.mjs
// "Continuar con Google" del portal del cliente (/), tal
// como en el mockup. A diferencia de Talkyria, el protocolo OAuth de
// Google SÍ está públicamente documentado y es estable, así que esto
// está escrito contra su especificación real, no adivinado.
//
// Solo sirve para ENTRAR a una cuenta que ya existe (dada de alta por
// correo+contraseña o por un pago VIP) — un correo de Google que no
// coincide con ningún suscriptor te manda de regreso a la portada para
// registrarte primero. Igual que el mockup, que solo mostraba el botón
// de Google en la pantalla de login, no en el checkout inicial.
//
// Requiere dos variables de entorno nuevas:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
// Ver README-v2.md para cómo obtenerlas y qué Redirect URI registrar.

import { crearSesion, buscarSuscriptorPorEmail } from './lib/auth.mjs';
import { randomBytes } from 'node:crypto';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SITE_URL = process.env.SITE_URL || 'https://monitor-jcf-comercial.netlify.app';
const REDIRECT_URI = `${SITE_URL}/.netlify/functions/google-auth?action=callback`;

function leerCookie(req, nombre) {
  const cookies = req.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return new Response('Google login no está configurado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Netlify).', { status: 500 });
  }

  // --- Paso 1: mandar al usuario a la pantalla de Google -------------------
  if (action === 'iniciar') {
    const state = randomBytes(16).toString('hex');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'select_account');

    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl.toString(),
        // Cookie de un solo uso, corta, solo para validar que el
        // regreso (callback) sea el mismo navegador que inició esto.
        'Set-Cookie': `g_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`
      }
    });
  }

  // --- Paso 2: Google regresa aquí con el código ----------------------------
  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const stateCookie = leerCookie(req, 'g_state');
    const limpiarCookie = 'g_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/';

    if (!code || !state || state !== stateCookie) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/?error=google_state', 'Set-Cookie': limpiarCookie }
      });
    }

    try {
      // Intercambia el código por tokens.
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error('Google no devolvió un access_token: ' + JSON.stringify(tokenData));
      }

      // Pide los datos básicos del perfil (correo, verificación).
      const perfilRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const perfil = await perfilRes.json();

      if (!perfil.email || perfil.email_verified !== true) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/?error=google_sin_verificar', 'Set-Cookie': limpiarCookie }
        });
      }

      const suscriptor = await buscarSuscriptorPorEmail(perfil.email.toLowerCase());
      if (!suscriptor) {
        // No existe cuenta con ese correo — a registrarse primero.
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/?google_email=${encodeURIComponent(perfil.email)}&error=sin_cuenta`,
            'Set-Cookie': limpiarCookie
          }
        });
      }

      const token = await crearSesion(suscriptor.id);
      // El token va en el fragmento (#), no en la query — así no queda
      // en el historial del navegador ni se manda a ningún servidor.
      return new Response(null, {
        status: 302,
        headers: { Location: `/#token=${token}`, 'Set-Cookie': limpiarCookie }
      });

    } catch (err) {
      console.error('Error en callback de Google:', err.message);
      return new Response(null, {
        status: 302,
        headers: { Location: '/?error=google_falla', 'Set-Cookie': limpiarCookie }
      });
    }
  }

  return new Response('Acción no reconocida', { status: 400 });
};
