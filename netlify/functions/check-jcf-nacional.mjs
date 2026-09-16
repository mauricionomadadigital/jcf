// netlify/functions/check-jcf-nacional.mjs
// Corre cada 5 min (detección rápida). Solo actúa si el periodo de
// monitoreo global está activo. Consulta solo los estados/municipios
// con al menos un suscriptor activo, compara contra el snapshot
// anterior y alerta por los canales que cada quien tenga activos:
// Telegram (todos), correo (VIP) y llamada Talkyria (VIP con teléfono).
// Cuando un municipio abre, además manda hasta 4 recordatorios por
// Telegram espaciados ~15 min durante la primera hora.

import { getStore } from '@netlify/blobs';
import { descargarCatalogo, estadoTexto, normalizar, enviarTelegram } from './lib/dtmlp.mjs';
import { enviarCorreo } from './lib/email.mjs';
import { llamarTalkyria } from './lib/talkyria.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function leerConfiguracion() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=*&limit=1`, {
    headers: headersSupabase()
  });
  const data = await res.json();
  return data && data[0] ? data[0] : null;
}

function dentroDelPeriodo(config) {
  if (!config || !config.periodo_inicio || !config.periodo_fin) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return hoy >= config.periodo_inicio && hoy <= config.periodo_fin;
}

async function cerrarPeriodoSiVencido(config) {
  if (!config || !config.periodo_fin) return { cerrado: false };
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy <= config.periodo_fin) return { cerrado: false };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true`, {
    method: 'PATCH',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ activo: false })
  });
  if (!res.ok) throw new Error('Error archivando suscriptores vencidos: ' + (await res.text()));
  const archivados = await res.json();
  return { cerrado: true, archivados: archivados.length };
}

async function leerSuscriptoresActivos() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&select=id,email,estado,municipio,telegram_chat_id,plan,phone,call_enabled,email_enabled,telegram_enabled`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error('No se pudieron leer los suscriptores: ' + (await res.text()));
  return res.json();
}

async function registrarCambio({ estado, municipio, estado_anterior, estado_nuevo }) {
  await fetch(`${SUPABASE_URL}/rest/v1/historial_cambios`, {
    method: 'POST',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ estado, municipio, estado_anterior, estado_nuevo })
  });
}

// Registra el intento de llamada con clave anti-duplicado (evento). Si ya
// existe (índice único), Supabase devuelve 409 y aquí lo tratamos como
// "ya se llamó" en vez de reintentar. El resultado real llega después
// por talkyria-webhook.mjs — aquí solo queda "pendiente" o "error" si
// Talkyria ni siquiera aceptó el disparo.
async function registrarLlamadaSiNueva({ suscriptorId, email, municipio, estado, evento, resultado }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/llamadas`, {
    method: 'POST',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      suscriptor_id: suscriptorId, email, municipio, estado, evento, resultado
    })
  });
  return res.ok;
}

function conTimeout(promesa, ms, mensajeError) {
  return Promise.race([
    promesa,
    new Promise((_, reject) => setTimeout(() => reject(new Error(mensajeError)), ms))
  ]);
}

async function ejecutarRevisionNacional() {
  const config = await leerConfiguracion();

  const cierre = await cerrarPeriodoSiVencido(config);
  if (cierre.cerrado) {
    return { ok: true, activo: false, motivo: 'Periodo vencido — suscriptores archivados automáticamente.', archivados: cierre.archivados };
  }

  if (!dentroDelPeriodo(config)) {
    return { ok: true, activo: false, motivo: 'Fuera del periodo de monitoreo global — no se procesó nada.' };
  }

  const suscriptores = await leerSuscriptoresActivos();
  if (suscriptores.length === 0) {
    return { ok: true, activo: true, motivo: 'No hay suscriptores activos — no se procesó nada.' };
  }

  const clavesBuscadas = new Set(
    suscriptores.map(s => normalizar(s.estado) + '|' + normalizar(s.municipio))
  );

  const { inicio, detmun } = await descargarCatalogo();
  const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));

  const municipiosRelevantes = (detmun || []).filter(m => {
    const nombreEstado = [...estadoIdPorNombre.entries()].find(([, id]) => id === Number(m.edo))?.[0];
    if (!nombreEstado) return false;
    return clavesBuscadas.has(nombreEstado + '|' + normalizar(m.lmun));
  });

  const store = getStore('jcf-nacional');
  const snapshotAnterior = (await store.get('snapshot', { type: 'json' })) || {};
  const snapshotNuevo = {};
  const cambios = [];

  for (const m of municipiosRelevantes) {
    const nombreEstado = [...estadoIdPorNombre.entries()].find(([, id]) => id === Number(m.edo))?.[0] || '';
    const clave = nombreEstado + '|' + normalizar(m.lmun);
    const nuevoTexto = estadoTexto(m.status);
    snapshotNuevo[clave] = nuevoTexto;

    const anterior = snapshotAnterior[clave];
    if (anterior !== undefined && anterior !== nuevoTexto && (m.status === 1 || m.status === 2)) {
      cambios.push({ clave, municipio: m.lmun, estadoAnterior: anterior, estadoNuevo: nuevoTexto });
    }
  }

  await store.setJSON('snapshot', snapshotNuevo);

  const ahora = Date.now();
  const MAX_RECORDATORIOS = 4;
  const VENTANA_MS = 60 * 60 * 1000;
  const ESPACIADO_MS = 15 * 60 * 1000;
  const refuerzos = (await store.get('refuerzos', { type: 'json' })) || {};

  let alertasEnviadas = 0;
  let llamadasIntentadas = 0;

  for (const cambio of cambios) {
    const estadoNombreReal = suscriptores.find(s => normalizar(s.estado) + '|' + normalizar(s.municipio) === cambio.clave)?.estado || '';

    await registrarCambio({
      estado: estadoNombreReal,
      municipio: cambio.municipio,
      estado_anterior: cambio.estadoAnterior,
      estado_nuevo: cambio.estadoNuevo
    });

    const destinatarios = suscriptores.filter(
      s => normalizar(s.estado) + '|' + normalizar(s.municipio) === cambio.clave
    );

    for (const s of destinatarios) {
      const textoTelegram = cambio.estadoNuevo === 'Abierto'
        ? `🔔🟢 ¡${cambio.municipio} ESTÁ ABIERTO AHORA!\n\n📍 ${estadoNombreReal}\n\n👉 Entra a la plataforma de Jóvenes Construyendo el Futuro y regístrate — los cupos se llenan rápido.`
        : `ℹ️ Actualización de ${cambio.municipio}, ${estadoNombreReal}\n\nEstado actual: ${cambio.estadoNuevo}\n\nSi ya alcanzó la meta, probablemente el cupo se llenó. Seguimos monitoreando por si hay más cambios.`;

      if (s.telegram_enabled !== false && s.telegram_chat_id) {
        const ok = await enviarTelegram(TELEGRAM_BOT_TOKEN, s.telegram_chat_id, textoTelegram);
        if (ok) alertasEnviadas++;
      }

      // Correo + llamada: solo VIP, y solo en la apertura (no en "meta alcanzada").
      if (s.plan === 'vip' && cambio.estadoNuevo === 'Abierto') {
        if (s.email_enabled !== false && s.email) {
          await enviarCorreo(
            s.email,
            `🟢 ${cambio.municipio} está abierto — Monitor JCF`,
            `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:26px;background:#0a1220;color:#eef2f9;border-radius:14px;">
              <h2 style="color:#34d399;">¡${cambio.municipio} está abierto!</h2>
              <p>${estadoNombreReal} — entra a la plataforma oficial de Jóvenes Construyendo el Futuro y regístrate lo antes posible.</p>
              <p style="text-align:center;margin:20px 0;"><a href="https://jovenesconstruyendoelfuturo.stps.gob.mx/" style="background:#34d399;color:#06281c;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Ir a la plataforma oficial</a></p>
            </div>`
          );
        }
        if (s.call_enabled && s.phone) {
          llamadasIntentadas++;
          const evento = `${s.id}|${cambio.clave}|apertura`;
          const resultado = await llamarTalkyria({
            telefono: `+52${s.phone}`,
            nombre: s.email.split('@')[0],
            municipio: cambio.municipio,
            estado: estadoNombreReal,
            externalId: evento
          });
          await registrarLlamadaSiNueva({
            suscriptorId: s.id, email: s.email, municipio: cambio.municipio, estado: estadoNombreReal,
            evento, resultado: resultado.ok ? 'pendiente' : 'error'
          });
        }
      }
    }

    if (cambio.estadoNuevo === 'Abierto') {
      refuerzos[cambio.clave] = { primera: ahora, ultimo: ahora, count: 1 };
    } else {
      delete refuerzos[cambio.clave];
    }
  }

  for (const [clave, texto] of Object.entries(snapshotNuevo)) {
    if (texto !== 'Abierto') continue;
    const r = refuerzos[clave];
    if (!r) continue;
    if (ahora - r.primera > VENTANA_MS) continue;
    if (r.count >= MAX_RECORDATORIOS) continue;
    if (ahora - r.ultimo < ESPACIADO_MS) continue;

    const destinatarios = suscriptores.filter(
      s => normalizar(s.estado) + '|' + normalizar(s.municipio) === clave && s.telegram_enabled !== false && s.telegram_chat_id
    );
    if (destinatarios.length === 0) continue;

    const estadoNombreReal = destinatarios[0].estado;
    const municipioNombreReal = destinatarios[0].municipio;

    for (const s of destinatarios) {
      const ok = await enviarTelegram(
        TELEGRAM_BOT_TOKEN,
        s.telegram_chat_id,
        `🔔🟢 Recordatorio (${r.count + 1}/${MAX_RECORDATORIOS}): ${municipioNombreReal} sigue ABIERTO\n\n📍 ${estadoNombreReal}\n\n👉 Si aún no te registras, entra a la plataforma ahora — puede cerrar en cualquier momento.`
      );
      if (ok) alertasEnviadas++;
    }
    refuerzos[clave] = { ...r, ultimo: ahora, count: r.count + 1 };
  }

  await store.setJSON('refuerzos', refuerzos);

  return {
    ok: true,
    activo: true,
    municipiosRevisados: municipiosRelevantes.length,
    cambiosDetectados: cambios.length,
    alertasEnviadas,
    llamadasIntentadas
  };
}

export default async () => {
  try {
    const resultado = await conTimeout(
      ejecutarRevisionNacional(),
      20000,
      'La revisión nacional tardó demasiado (más de 20 segundos) y se canceló'
    );
    return new Response(JSON.stringify(resultado), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    console.error('Error en revisión nacional:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
};

// Cada 5 minutos — detección más rápida cuando un municipio abre.
export const config = {
  schedule: '*/5 * * * *'
};
