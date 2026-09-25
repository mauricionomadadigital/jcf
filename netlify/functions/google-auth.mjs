// netlify/functions/google-auth.mjs
// "Continuar con Google" del portal del cliente (/), tal
// como en el mockup. A diferencia de Talkyria, el protocolo OAuth de
// Google SÍ está públicamente documentado y es estable, así que esto
// está escrito contra su especificación real, no adivinado.
//
// Sirve para ENTRAR y para REGISTRARSE:
//  - Desde /entrar.html (sin datos de registro): entra a la cuenta que
//    ya existe con ese correo. Si no existe, manda a la portada a
//    registrarse.
//  - Desde / (registro, con nombre/estado/municipio): si el correo no
//    tiene cuenta activa, la crea en plan Gratis (lib/alta-free.mjs) y
//    entra directo al panel. Si ya tenía cuenta activa, simplemente entra.
// Con siguiente=vip, al terminar manda a /checkout-vip.html en vez del
// panel (solo pago, sin volver a pedir datos).
//
// Requiere dos variables de entorno nuevas:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
// Ver README-v2.md para cómo obtenerlas y qué Redirect URI registrar.

import { crearSesion, buscarSuscriptorPorEmail } from './lib/auth.mjs';
import { altaFree } from './lib/alta-free.mjs';
import { registroEstaAbierto } from './lib/config.mjs';
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

// Datos del formulario de registro, guardados en una cookie corta entre
// la ida a Google y el regreso (base64url de un JSON).
function leerRegistro(req) {
  const raw = leerCookie(req, 'g_reg');
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return null; }
}

function redirigir(location, ...cookies) {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
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

    // Viene del formulario de registro: guardamos sus datos para crear
    // la cuenta Gratis al regresar de Google.
    const p = url.searchParams;
    const registro = (p.get('estado') && p.get('municipio')) ? {
      nombre: (p.get('nombre') || '').trim().slice(0, 120),
      estado: p.get('estado').trim().slice(0, 120),
      municipio: p.get('municipio').trim().slice(0, 160),
      ref: (p.get('ref') || '').trim().toUpperCase().slice(0, 20) || null,
      siguiente: p.get('siguiente') === 'vip' ? 'vip' : null
    } : (p.get('siguiente') === 'vip' ? { siguiente: 'vip' } : null);
    const regCookie = registro
      ? `g_reg=${Buffer.from(JSON.stringify(registro)).toString('base64url')}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`
      : 'g_reg=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/';

    // Cookie de un solo uso, corta, solo para validar que el regreso
    // (callback) sea el mismo navegador que inició esto.
    return redirigir(
      authUrl.toString(),
      `g_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
      regCookie
    );
  }

  // --- Paso 2: Google regresa aquí con el código ----------------------------
  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const stateCookie = leerCookie(req, 'g_state');
    const registro = leerRegistro(req);
    const limpiarState = 'g_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/';
    const limpiarReg = 'g_reg=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/';
    const ir = (location) => redirigir(location, limpiarState, limpiarReg);

    if (!code || !state || state !== stateCookie) {
      return ir('/entrar.html?error=google_state');
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
        return ir('/entrar.html?error=google_sin_verificar');
      }

      const email = perfil.email.toLowerCase();
      let suscriptor = await buscarSuscriptorPorEmail(email);
      const vieneDeRegistro = !!(registro && registro.estado && registro.municipio);

      if (vieneDeRegistro && !(suscriptor && suscriptor.activo)) {
        // Registro con Google: sin cuenta activa con ese correo, se crea
        // (o se reactiva la archivada) en plan Gratis, igual que con
        // correo+contraseña pero sin contraseña.
        if (!(await registroEstaAbierto())) {
          return ir('/?error=registro_cerrado');
        }
        suscriptor = await altaFree({
          email,
          estado: registro.estado,
          municipio: registro.municipio,
          password: null,
          referredBy: registro.ref || null,
          nombre: registro.nombre || perfil.name || '',
          telefono: '',
          telefonoPrefijo: '+52'
        });
      }

      if (!suscriptor) {
        // Entró desde "Entrar" con un Google sin cuenta — a registrarse.
        return ir(`/?google_email=${encodeURIComponent(perfil.email)}&error=sin_cuenta`);
      }

      const token = await crearSesion(suscriptor.id);
      // El token va en el fragmento (#), no en la query — así no queda
      // en el historial del navegador ni se manda a ningún servidor.
      // Si pidió VIP, directo al checkout (solo pago); si no, al panel.
      const destino = (registro?.siguiente === 'vip' && suscriptor.plan !== 'vip')
        ? '/checkout-vip.html'
        : '/panel.html';
      return ir(`${destino}#token=${token}`);

    } catch (err) {
      console.error('Error en callback de Google:', err.message);
      return ir('/entrar.html?error=google_falla');
    }
  }

  return new Response('Acción no reconocida', { status: 400 });
};
