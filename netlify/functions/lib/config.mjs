// netlify/functions/lib/config.mjs
// Helper compartido para leer la configuración global — usado por los
// endpoints de alta (register-free, create-preference) para respetar
// el interruptor "Registro abierto" del panel admin.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function registroEstaAbierto() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=registro_abierto&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const data = await res.json();
    // Si no hay fila de configuración todavía, por defecto dejamos
    // registrar (fail-open) para no bloquear el lanzamiento por un
    // detalle de configuración faltante.
    if (!Array.isArray(data) || !data[0]) return true;
    return data[0].registro_abierto !== false;
  } catch {
    return true;
  }
}
