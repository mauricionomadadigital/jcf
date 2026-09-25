// netlify/functions/lib/precio.mjs
// Precio VIP vigente, configurable desde el panel admin (tabla
// configuracion). Es la ÚNICA fuente del precio: create-preference cobra
// esto, config-publica lo muestra y los correos lo citan. Si la columna
// todavía no existe (migración 006 sin correr), se usa $100.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const PRECIO_VIP_DEFAULT = 100;

export function normalizarPrecio(fila = {}) {
  const precio = Number(fila.vip_precio);
  const regular = Number(fila.vip_precio_regular);
  const vip_precio = precio > 0 ? precio : PRECIO_VIP_DEFAULT;
  return {
    vip_precio,
    // El "antes" tachado solo tiene sentido si es mayor que el actual.
    vip_precio_regular: regular > vip_precio ? regular : null,
    vip_oferta_texto: (fila.vip_oferta_texto || '').trim() || null,
    vip_escasez_texto: (fila.vip_escasez_texto || '').trim() || null
  };
}

export async function precioVip() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=*&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const data = await res.json();
    return normalizarPrecio(Array.isArray(data) && data[0] ? data[0] : {});
  } catch {
    return normalizarPrecio({});
  }
}

export function formatoMxn(n) {
  return '$' + (Number.isInteger(n) ? n : n.toFixed(2)) + ' MXN';
}
