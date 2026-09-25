// netlify/functions/check-jcf-nacional.mjs
// El cron de Netlify corre cada 5 minutos (el tick más fino que hace
// falta), pero Free y VIP se revisan a su PROPIA cadencia configurable
// desde el panel admin (configuracion.free_frecuencia_min /
// vip_frecuencia_min — por defecto 120 y 10) sin necesitar redeploy:
// aquí adentro se guarda cuándo fue la última revisión de cada plan en
// Netlify Blobs, y solo se hace el trabajo de ese plan cuando ya le tocaba.
//
// Diferencia real entre planes — nunca solo de texto:
// - Ambos reciben Telegram + correo cuando su municipio abre.
// - Solo VIP recibe también una llamada (Talkyria), y solo VIP recibe
//   hasta 4 recordatorios por Telegram espaciados ~15 min en la primera
//   hora (tiene sentido con su cadencia de minutos; no con la de Free,
//   que ya revisa cada 1-2 horas).
// - VIP revisa mucho más seguido (10 min por defecto) que Free (2 horas
//   por defecto) — eso es lo que en verdad vale el pago, no el canal.

import { getStore } from '@netlify/blobs';
import { descargarCatalogo, estadoTexto, normalizar, enviarTelegram } from './lib/dtmlp.mjs';
import { lineaSoporteVip } from './lib/soporte.mjs';
import { enviarCorreo } from './lib/email.mjs';
import { llamarTalkyria } from './lib/talkyria.mjs';
import { registrarFallo } from './lib/fallos.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const DEFAULT_VIP_MIN = 10;
const DEFAULT_FREE_MIN = 120;
const VIP_DURACION_MS = 14 * 24 * 60 * 60 * 1000;
const MARGEN_MIN = 0.5; // tolerancia para el jitter normal del cron

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

// --- Cierre de periodo + purga de cuentas archivadas hace 3 periodos ------

async function purgarInactivosDe3Periodos() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.false&select=id,periodos_inactivo`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error('Error leyendo cuentas archivadas: ' + (await res.text()));
  const inactivos = await res.json();

  let purgados = 0;
  for (const s of inactivos) {
    const nuevoContador = (s.periodos_inactivo || 0) + 1;
    if (nuevoContador >= 3) {
      await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${s.id}`, {
        method: 'DELETE',
        headers: headersSupabase()
      });
      purgados++;
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${s.id}`, {
        method: 'PATCH',
        headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({ periodos_inactivo: nuevoContador })
      });
    }
  }
  return purgados;
}

// Solo actúa la PRIMERA vez que detecta que un periodo_fin concreto ya
// venció — usa un marcador en Blobs para no repetir la purga en cada
// tick de 5 min mientras el periodo siga vencido (que puede ser semanas,
// hasta que el admin arranque el siguiente periodo).
async function cerrarPeriodoSiVencido(config, store) {
  if (!config || !config.periodo_fin) return { cerrado: false };
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy <= config.periodo_fin) return { cerrado: false };

  const yaProcesado = await store.get('ultimo_cierre_procesado', { type: 'text' });
  if (yaProcesado === config.periodo_fin) {
    return { cerrado: true, archivados: 0, purgados: 0 };
  }

  const purgados = await purgarInactivosDe3Periodos();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true`, {
    method: 'PATCH',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ activo: false, archivado_en: new Date().toISOString(), periodos_inactivo: 0 })
  });
  if (!res.ok) throw new Error('Error archivando suscriptores vencidos: ' + (await res.text()));
  const archivados = await res.json();

  await store.set('ultimo_cierre_procesado', config.periodo_fin);

  return { cerrado: true, archivados: archivados.length, purgados };
}

// --- Degradación individual de VIP a los 14 días --------------------------

async function degradarVipVencidos() {
  const limite = new Date(Date.now() - VIP_DURACION_MS).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?plan=eq.vip&activo=eq.true&vip_started_at=not.is.null&vip_started_at=lt.${encodeURIComponent(limite)}`,
    {
      method: 'PATCH',
      headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ plan: 'free', call_enabled: false })
    }
  );
  if (!res.ok) throw new Error('Error degradando VIP vencidos: ' + (await res.text()));
  const degradados = await res.json();
  return degradados.length;
}

// --- Revisión por plan, cada uno con su propia cadencia y snapshot --------

function yaLeToca(ultimaRevisionIso, frecuenciaMin) {
  if (!ultimaRevisionIso) return true;
  const minutosPasados = (Date.now() - new Date(ultimaRevisionIso).getTime()) / 60000;
  return minutosPasados >= frecuenciaMin - MARGEN_MIN;
}

async function leerSuscriptoresActivosDePlan(plan) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&plan=eq.${plan}&select=id,email,estado,municipio,telegram_chat_id,phone,telefono_prefijo,call_enabled,email_enabled,telegram_enabled`,
    { headers: headersSupabase() }
  );
  if (!res.ok) throw new Error('No se pudieron leer los suscriptores: ' + (await res.text()));
  return res.json();
}

async function registrarCambioHistorial({ estado, municipio, estado_anterior, estado_nuevo }) {
  await fetch(`${SUPABASE_URL}/rest/v1/historial_cambios`, {
    method: 'POST',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ estado, municipio, estado_anterior, estado_nuevo })
  });
}

async function registrarLlamadaSiNueva({ suscriptorId, email, municipio, estado, evento, resultado }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/llamadas`, {
    method: 'POST',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({ suscriptor_id: suscriptorId, email, municipio, estado, evento, resultado })
  });
  return res.ok;
}

// Revisa un plan (free o vip) contra SU PROPIO snapshot — así cada uno
// compara contra lo último que él mismo sabía, sin importar cada cuánto
// corre el otro plan. `catalogo` se descarga una sola vez por tick y se
// comparte entre planes si a ambos les toca revisar en el mismo tick.
async function leToca(plan, frecuenciaMin, store) {
  const ultima = await store.get(`ultima_revision_${plan}`, { type: 'text' });
  return yaLeToca(ultima, frecuenciaMin);
}

async function revisarPlan({ plan, store, catalogo, registrarHistorial }) {
  const claveUltima = `ultima_revision_${plan}`;
  const claveSnapshot = `snapshot_${plan}`;
  const claveRefuerzos = `refuerzos_${plan}`;

  const suscriptores = await leerSuscriptoresActivosDePlan(plan);
  if (suscriptores.length === 0) {
    await store.set(claveUltima, new Date().toISOString());
    return { reviso: true, motivo: 'sin_suscriptores' };
  }

  const clavesBuscadas = new Set(suscriptores.map(s => normalizar(s.estado) + '|' + normalizar(s.municipio)));
  const { estadoIdPorNombre, detmun } = catalogo;

  const municipiosRelevantes = (detmun || []).filter(m => {
    const nombreEstado = [...estadoIdPorNombre.entries()].find(([, id]) => id === Number(m.edo))?.[0];
    if (!nombreEstado) return false;
    return clavesBuscadas.has(nombreEstado + '|' + normalizar(m.lmun));
  });

  const snapshotAnterior = (await store.get(claveSnapshot, { type: 'json' })) || {};
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

  await store.setJSON(claveSnapshot, snapshotNuevo);

  const ahora = Date.now();
  const MAX_RECORDATORIOS = 4;
  const VENTANA_MS = 60 * 60 * 1000;
  const ESPACIADO_MS = 15 * 60 * 1000;
  const refuerzos = plan === 'vip' ? ((await store.get(claveRefuerzos, { type: 'json' })) || {}) : {};

  let alertasEnviadas = 0;
  let llamadasIntentadas = 0;

  for (const cambio of cambios) {
    const estadoNombreReal = suscriptores.find(s => normalizar(s.estado) + '|' + normalizar(s.municipio) === cambio.clave)?.estado || '';

    if (registrarHistorial) {
      await registrarCambioHistorial({
        estado: estadoNombreReal, municipio: cambio.municipio,
        estado_anterior: cambio.estadoAnterior, estado_nuevo: cambio.estadoNuevo
      });
    }

    const destinatarios = suscriptores.filter(s => normalizar(s.estado) + '|' + normalizar(s.municipio) === cambio.clave);

    for (const s of destinatarios) {
      const textoTelegram = cambio.estadoNuevo === 'Abierto'
        ? `🔔🟢 ¡${cambio.municipio} ESTÁ ABIERTO AHORA!\n\n📍 ${estadoNombreReal}\n\n👉 Entra a la plataforma de Jóvenes Construyendo el Futuro y regístrate — los cupos se llenan rápido.`
        : `ℹ️ Actualización de ${cambio.municipio}, ${estadoNombreReal}\n\nEstado actual: ${cambio.estadoNuevo}\n\nSi ya alcanzó la meta, probablemente el cupo se llenó. Seguimos monitoreando por si hay más cambios.`;

      if (s.telegram_enabled !== false && s.telegram_chat_id) {
        // A VIP se le agrega el acceso a soporte directo.
        const ok = await enviarTelegram(TELEGRAM_BOT_TOKEN, s.telegram_chat_id, textoTelegram + (plan === 'vip' ? lineaSoporteVip() : ''));
        if (ok) alertasEnviadas++;
      }

      // Correo: para AMBOS planes, solo en la apertura (no en "meta
      // alcanzada" — no hay nada urgente que decir ahí).
      if (cambio.estadoNuevo === 'Abierto' && s.email_enabled !== false && s.email) {
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

      // Llamada: exclusiva VIP, y por ahora solo para números de México
      // (+52) — es lo único que se probó con Talkyria en producción. El
      // panel ya bloquea activar llamadas con otro prefijo, pero se
      // valida también aquí por si acaso.
      const prefijo = s.telefono_prefijo || '+52';
      if (plan === 'vip' && cambio.estadoNuevo === 'Abierto' && s.call_enabled && s.phone && prefijo === '+52') {
        llamadasIntentadas++;
        const evento = `${s.id}|${cambio.clave}|apertura`;
        const resultado = await llamarTalkyria({
          telefono: `${prefijo}${s.phone}`, nombre: s.email.split('@')[0],
          municipio: cambio.municipio, estado: estadoNombreReal, externalId: evento
        });
        await registrarLlamadaSiNueva({
          suscriptorId: s.id, email: s.email, municipio: cambio.municipio, estado: estadoNombreReal,
          evento, resultado: resultado.ok ? 'pendiente' : 'error'
        });
      }
    }

    // Recordatorios reforzados: solo VIP, porque su cadencia de minutos
    // encaja con espaciarlos cada ~15 min — en Free no tiene sentido con
    // una revisión de 1-2 horas.
    if (plan === 'vip') {
      if (cambio.estadoNuevo === 'Abierto') {
        refuerzos[cambio.clave] = { primera: ahora, ultimo: ahora, count: 1 };
      } else {
        delete refuerzos[cambio.clave];
      }
    }
  }

  if (plan === 'vip') {
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
          TELEGRAM_BOT_TOKEN, s.telegram_chat_id,
          `🔔🟢 Recordatorio (${r.count + 1}/${MAX_RECORDATORIOS}): ${municipioNombreReal} sigue ABIERTO\n\n📍 ${estadoNombreReal}\n\n👉 Si aún no te registras, entra a la plataforma ahora — puede cerrar en cualquier momento.` + lineaSoporteVip()
        );
        if (ok) alertasEnviadas++;
      }
      refuerzos[clave] = { ...r, ultimo: ahora, count: r.count + 1 };
    }
    await store.setJSON(claveRefuerzos, refuerzos);
  }

  await store.set(claveUltima, new Date().toISOString());

  return {
    reviso: true,
    municipiosRevisados: municipiosRelevantes.length,
    cambiosDetectados: cambios.length,
    alertasEnviadas,
    llamadasIntentadas
  };
}

function conTimeout(promesa, ms, mensajeError) {
  return Promise.race([
    promesa,
    new Promise((_, reject) => setTimeout(() => reject(new Error(mensajeError)), ms))
  ]);
}

async function ejecutarRevisionNacional() {
  const config = await leerConfiguracion();
  const store = getStore('jcf-nacional');

  const cierre = await cerrarPeriodoSiVencido(config, store);
  if (cierre.cerrado) {
    return { ok: true, activo: false, motivo: 'Periodo vencido — suscriptores archivados automáticamente.', ...cierre };
  }

  if (!dentroDelPeriodo(config)) {
    return { ok: true, activo: false, motivo: 'Fuera del periodo de monitoreo global — no se procesó nada.' };
  }

  const vipDegradados = await degradarVipVencidos();

  const frecVip = config.vip_frecuencia_min || DEFAULT_VIP_MIN;
  const frecFree = config.free_frecuencia_min || DEFAULT_FREE_MIN;

  const [vipLeToca, freeLeToca] = await Promise.all([
    leToca('vip', frecVip, store),
    leToca('free', frecFree, store)
  ]);

  if (!vipLeToca && !freeLeToca) {
    return { ok: true, activo: true, motivo: 'A ningún plan le tocaba revisar todavía en este tick.', vipDegradados };
  }

  // El catálogo del gobierno se descarga una sola vez por tick (y solo si
  // hace falta), aunque a los dos planes les toque revisar en el mismo tick.
  const { inicio, detmun } = await descargarCatalogo();
  const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
  const catalogo = { estadoIdPorNombre, detmun };

  // El historial de cambios (para el admin) se registra la primera vez
  // que CUALQUIER plan detecta el cambio en este tick, para no duplicar
  // la misma noticia dos veces si ambos revisan en el mismo momento.
  let historialYaRegistradoEsteTick = false;
  const vip = vipLeToca
    ? await revisarPlan({ plan: 'vip', store, catalogo, registrarHistorial: true })
    : { reviso: false };
  if (vip.cambiosDetectados) historialYaRegistradoEsteTick = true;
  const free = freeLeToca
    ? await revisarPlan({ plan: 'free', store, catalogo, registrarHistorial: !historialYaRegistradoEsteTick })
    : { reviso: false };

  return { ok: true, activo: true, vipDegradados, vip, free };
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
    await registrarFallo({ tipo: 'cron', origen: 'check-jcf-nacional', detalle: String(err && err.message ? err.message : err) });
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
};

// Tick base cada 5 minutos — la cadencia real de cada plan se decide
// adentro (configuracion.vip_frecuencia_min / free_frecuencia_min).
export const config = {
  schedule: '*/5 * * * *'
};
