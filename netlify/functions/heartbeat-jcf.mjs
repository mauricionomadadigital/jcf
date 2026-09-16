// netlify/functions/heartbeat-jcf.mjs
// Corre cada hora, solo dentro del periodo de monitoreo activo.
// A diferencia de check-jcf-nacional (que solo avisa cuando algo CAMBIA),
// este manda un mensaje de "seguimos vigilando" a quien todavía sigue
// cerrado — para que el usuario sienta que el sistema está vivo,
// sin inundarlo de alertas falsas cada 15 minutos.

import { descargarCatalogo, estadoTexto, normalizar, enviarTelegram } from './lib/dtmlp.mjs';
import { registrarFallo } from './lib/fallos.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function headersSupabase() {
  return { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` };
}

async function leerConfiguracion() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=*&limit=1`, { headers: headersSupabase() });
  const data = await res.json();
  return data && data[0] ? data[0] : null;
}

function dentroDelPeriodo(config) {
  if (!config || !config.periodo_inicio || !config.periodo_fin) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return hoy >= config.periodo_inicio && hoy <= config.periodo_fin;
}

async function leerSuscriptoresActivos() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&telegram_chat_id=not.is.null&telegram_enabled=not.is.false&select=id,estado,municipio,telegram_chat_id`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default async () => {
  try {
    const config = await leerConfiguracion();
    if (!dentroDelPeriodo(config)) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Fuera del periodo — sin heartbeat.' }));
    }

    const suscriptores = await leerSuscriptoresActivos();
    if (suscriptores.length === 0) {
      return new Response(JSON.stringify({ ok: true, motivo: 'Sin suscriptores con Telegram vinculado.' }));
    }

    const { inicio, detmun } = await descargarCatalogo();
    const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });

    let enviados = 0;
    for (const s of suscriptores) {
      const idedo = estadoIdPorNombre.get(normalizar(s.estado));
      const m = (detmun || []).find(x => Number(x.edo) === idedo && normalizar(x.lmun) === normalizar(s.municipio));
      const estadoActual = m ? estadoTexto(m.status) : 'Desconocido';

      // Solo mandamos heartbeat si SIGUE cerrado — si ya está Abierto/Meta alcanzada,
      // ese cambio ya lo cubrió (o lo cubrirá) check-jcf-nacional con su propia alerta.
      if (estadoActual !== 'Cerrado') continue;

      const ok = await enviarTelegram(
        TELEGRAM_BOT_TOKEN,
        s.telegram_chat_id,
        `✅ Seguimos vigilando ${s.municipio}, ${s.estado}\nEstado actual: Cerrado\nÚltima revisión: ${hora} hrs\n\nTe avisaremos en cuanto abra.`
      );
      if (ok) enviados++;
    }

    return new Response(JSON.stringify({ ok: true, revisados: suscriptores.length, enviados }));
  } catch (err) {
    console.error('Error heartbeat-jcf:', err.message);
    await registrarFallo({ tipo: 'cron', origen: 'heartbeat-jcf', detalle: err.message });
    return new Response(JSON.stringify({ ok: false, error: err.message }));
  }
};

// Cada hora en punto.
export const config = {
  schedule: '0 * * * *'
};
