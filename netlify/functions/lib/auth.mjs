// netlify/functions/lib/auth.mjs
// Contraseñas y sesiones para el portal del cliente. Usa node:crypto
// (scrypt) que ya viene incluido en Node — no agrega dependencias nuevas.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

// --- Contraseñas -------------------------------------------------------
// Formato almacenado: "salt:hash", ambos en hex.
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const testBuffer = scryptSync(password, salt, 64);
  if (hashBuffer.length !== testBuffer.length) return false;
  return timingSafeEqual(hashBuffer, testBuffer);
}

// --- Sesiones ------------------------------------------------------------
const DIAS_SESION = 30;

export async function crearSesion(suscriptorId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + DIAS_SESION * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sesiones`, {
    method: 'POST',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ token, suscriptor_id: suscriptorId, expires_at: expiresAt })
  });
  if (!res.ok) throw new Error('No se pudo crear la sesión: ' + (await res.text()));
  return token;
}

export async function borrarSesion(token) {
  await fetch(`${SUPABASE_URL}/rest/v1/sesiones?token=eq.${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: headersSupabase()
  });
}

// Devuelve el suscriptor dueño del token, o null si no hay sesión válida.
export async function suscriptorDesdeToken(token) {
  if (!token) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sesiones?token=eq.${encodeURIComponent(token)}&select=suscriptor_id,expires_at&limit=1`,
    { headers: headersSupabase() }
  );
  const filas = await res.json();
  const sesion = Array.isArray(filas) ? filas[0] : null;
  if (!sesion) return null;
  if (new Date(sesion.expires_at).getTime() < Date.now()) {
    await borrarSesion(token);
    return null;
  }
  const resSusc = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${sesion.suscriptor_id}&select=*&limit=1`,
    { headers: headersSupabase() }
  );
  const susc = await resSusc.json();
  return Array.isArray(susc) && susc[0] ? susc[0] : null;
}

export function tokenDesdeRequest(req) {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// --- Código de referido --------------------------------------------------
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos

function generarCandidato() {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return out;
}

// Genera un código único de 6 caracteres reintentando contra la tabla.
export async function generarCodigoReferido() {
  for (let intento = 0; intento < 8; intento++) {
    const candidato = generarCandidato();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/suscriptores?referral_code=eq.${candidato}&select=id&limit=1`,
      { headers: headersSupabase() }
    );
    const filas = await res.json();
    if (Array.isArray(filas) && filas.length === 0) return candidato;
  }
  // Extremadamente improbable, pero por si acaso: agrega sufijo aleatorio.
  return generarCandidato() + Math.floor(Math.random() * 10);
}

// --- Recuperación de contraseña ------------------------------------------
export function generarTokenReset() {
  return randomBytes(24).toString('hex');
}

// Búsqueda por correo, usada tanto en el login normal como en Google —
// toma la cuenta más reciente si alguna vez hubo más de una fila con
// ese correo (ej. renovaciones VIP crean una fila nueva por pago).
export async function buscarSuscriptorPorEmail(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc&limit=1`,
    { headers: headersSupabase() }
  );
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}
