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
import { descargarCatalogo, estadoTexto, normalizar } from './lib/dtmlp.mjs';
import { cargarFlujo } from './lib/flujo.mjs';
import { CONSTRUCTORES, enviarEstacion, volcarEnvios } from './lib/flujo-mensajes.mjs';
import { precioVip, formatoMxn } from './lib/precio.mjs';
import { llamarTalkyria } from './lib/talkyria.mjs';
import { registrarFallo } from './lib/fallos.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  const cupones = await asignarCuponesSiguientePeriodo(config);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true`, {
    method: 'PATCH',
    headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ activo: false, archivado_en: new Date().toISOString(), periodos_inactivo: 0 })
  });
  if (!res.ok) throw new Error('Error archivando suscriptores vencidos: ' + (await res.text()));
  const archivados = await res.json();

  await store.set('ultimo_cierre_procesado', config.periodo_fin);

  return { cerrado: true, archivados: archivados.length, purgados, cupones };
}

// Cupón de descuento para el SIGUIENTE periodo (cuando la plataforma vuelva
// a abrir): solo para quien pasó por VIP en el periodo que cierra. Primer
// VIP (ciclo 1) = 50 %; ya había sido VIP antes (ciclo 2+) = 70 %. Quien
// nunca fue VIP no recibe nada. Se consume al pagar (webhook.mjs lo pone
// en 0) y se aplica aunque la cuenta esté en Gratis (create-preference).
async function asignarCuponesSiguientePeriodo(config) {
  const desde = config.periodo_inicio
    ? `&vip_started_at=gte.${encodeURIComponent(config.periodo_inicio)}`
    : '&vip_started_at=not.is.null';
  const asignar = async (filtroCiclo, porcentaje) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true${desde}&${filtroCiclo}`, {
      method: 'PATCH',
      headers: { ...headersSupabase(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ discount_percent: porcentaje })
    });
    if (!res.ok) throw new Error('Error asignando cupones: ' + (await res.text()));
    return (await res.json()).length;
  };
  const de70 = await asignar('cycle_number=gte.2', 70);
  const de50 = await asignar('or=(cycle_number.lt.2,cycle_number.is.null)', 50);
  return { de50, de70 };
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
  return res.json();
}

// --- Revisión por plan, cada uno con su propia cadencia y snapshot --------

function yaLeToca(ultimaRevisionIso, frecuenciaMin) {
  if (!ultimaRevisionIso) return true;
  const minutosPasados = (Date.now() - new Date(ultimaRevisionIso).getTime()) / 60000;
  return minutosPasados >= frecuenciaMin - MARGEN_MIN;
}

async function leerSuscriptoresActivosDePlan(plan) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&plan=eq.${plan}&select=id,email,estado,municipio,plan,telegram_chat_id,phone,telefono_prefijo,call_enabled,email_enabled,telegram_enabled`,
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

// --- Llamadas VIP ---------------------------------------------------------
// Solo números de México (+52) — es lo único probado con Talkyria. Cada
// intento usa su propio evento (externalId de Talkyria): 1ª "…|apertura",
// reintentos "…|apertura|2", "…|apertura|3". Nunca llama si el cliente
// apagó la llamada o no tiene teléfono.
function puedeLlamar(s) {
  return !!(s.call_enabled && s.phone && (s.telefono_prefijo || '+52') === '+52');
}
async function llamarVip(s, { clave, municipio, estado, intento }) {
  const evento = `${s.id}|${clave}|apertura${intento > 1 ? '|' + intento : ''}`;
  const resultado = await llamarTalkyria({
    telefono: `+52${s.phone}`, nombre: s.email.split('@')[0],
    municipio, estado, externalId: evento
  });
  await registrarLlamadaSiNueva({
    suscriptorId: s.id, email: s.email, municipio, estado,
    evento, resultado: resultado.ok ? 'pendiente' : 'error'
  });
  return resultado.ok;
}
// ¿Alguna llamada de esta apertura fue contestada? Contestó = cualquier
// resultado que no sea no contestó, buzón, error o aún pendiente (si
// Talkyria no ha confirmado, no suponemos que le llegó).
const RESULTADOS_SIN_CONTESTAR = new Set(['no_contesto', 'buzon', 'error', 'pendiente']);
async function yaContesto(s, clave) {
  const patron = encodeURIComponent(`${s.id}|${clave}|apertura*`);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/llamadas?suscriptor_id=eq.${s.id}&evento=like.${patron}&select=resultado`, { headers: headersSupabase() });
  if (!res.ok) return false;
  const filas = await res.json();
  return filas.some(f => !RESULTADOS_SIN_CONTESTAR.has(f.resultado));
}

// --- Recordatorios reforzados VIP (estación 6 del flujo) ---------------------
// Corre en CADA tick de 5 min, sin importar la frecuencia de revisión VIP.
// Por cliente y por municipio abierto: Telegram cada N min, correo cada M
// min y reintento de llamada cada K min mientras ninguna haya sido
// contestada (máx. L llamadas contando la del minuto 0). Contestar detiene
// solo las llamadas. Todo se corta si el municipio deja de estar Abierto
// o se cumple la ventana.
async function procesarRefuerzosVip(store) {
  const refuerzos = (await store.get('refuerzos_vip', { type: 'json' })) || {};
  const claves = Object.keys(refuerzos);
  if (!claves.length) return { secuencias: 0 };
  const flujo = await cargarFlujo();
  const snapshot = (await store.get('snapshot_vip', { type: 'json' })) || {};
  const ahora = Date.now();
  const MIN = 60 * 1000;
  const tgCada = flujo.param('recordatorio_vip', 'telegram_cada_min') * MIN;
  const correoCada = flujo.param('recordatorio_vip', 'correo_cada_min') * MIN;
  const llamadaCada = flujo.param('recordatorio_vip', 'llamada_cada_min') * MIN;
  const llamadasMax = flujo.param('recordatorio_vip', 'llamadas_max');
  const ventana = flujo.param('recordatorio_vip', 'ventana_min') * MIN;
  const totalTg = Math.floor(ventana / tgCada);
  const activa = flujo.activo('recordatorio_vip');
  const vips = activa ? await leerSuscriptoresActivosDePlan('vip') : [];
  const res = { secuencias: 0, telegram: 0, correos: 0, llamadas: 0 };

  for (const clave of claves) {
    const r = refuerzos[clave];
    // Secuencias del formato anterior (sin "usuarios") o ya vencidas/cerradas: fuera.
    if (!r.usuarios || snapshot[clave] !== 'Abierto' || ahora - r.primera > ventana) { delete refuerzos[clave]; continue; }
    if (!activa) continue; // apagada en Admin > Flujo: se pausa sin borrar
    res.secuencias++;
    const transcurrido = ahora - r.primera;
    const destinatarios = vips.filter(s => normalizar(s.estado) + '|' + normalizar(s.municipio) === clave);
    for (const s of destinatarios) {
      const u = r.usuarios[s.id] || (r.usuarios[s.id] = { tg: 0, correo: 0, llamadas: 0 });
      const datos = { n: u.tg + 1, total: totalTg, municipio: r.municipio, estado: r.estado };
      // Telegram: uno por tick como máximo, aunque se hayan perdido ticks.
      if (transcurrido >= (u.tg + 1) * tgCada && u.tg < totalTg) {
        const e = await enviarEstacion('recordatorio_vip', s, CONSTRUCTORES.recordatorio_vip(flujo, s, datos), { soloCanal: 'telegram' });
        u.tg++; if (e.telegram) res.telegram++;
      }
      if (correoCada > 0 && transcurrido >= (u.correo + 1) * correoCada) {
        const e = await enviarEstacion('recordatorio_vip', s, CONSTRUCTORES.recordatorio_vip(flujo, s, datos), { soloCanal: 'correo' });
        u.correo++; if (e.correo) res.correos++;
      }
      if (u.llamadas < llamadasMax && transcurrido >= u.llamadas * llamadaCada && puedeLlamar(s)) {
        if (await yaContesto(s, clave)) {
          u.llamadas = llamadasMax; // contestó: ya no más llamadas (Telegram y correo siguen)
        } else {
          u.llamadas++;
          await llamarVip(s, { clave, municipio: r.municipio, estado: r.estado, intento: u.llamadas });
          res.llamadas++;
        }
      }
    }
  }
  await volcarEnvios();
  await store.setJSON('refuerzos_vip', refuerzos);
  return res;
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
  // Estaciones 5, 6 y 7 del flujo (Admin > Flujo): textos, encendido y
  // cantidades de los recordatorios VIP, editables sin deploy.
  const flujo = await cargarFlujo();
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

    const esApertura = cambio.estadoNuevo === 'Abierto';
    const datos = { municipio: cambio.municipio, estado: estadoNombreReal, estadoNuevo: cambio.estadoNuevo };
    const llamadasPorCliente = {};
    for (const s of destinatarios) {
      // Apertura: Telegram + correo, nunca se apaga. Cambio de estado (p. ej.
      // Meta alcanzada): solo Telegram, y se puede apagar en Admin > Flujo.
      if (esApertura) {
        const r = await enviarEstacion('apertura', s, CONSTRUCTORES.apertura(flujo, s, datos));
        if (r.telegram) alertasEnviadas++;
      } else if (flujo.activo('cambio_estado')) {
        const r = await enviarEstacion('cambio_estado', s, CONSTRUCTORES.cambio_estado(flujo, s, datos));
        if (r.telegram) alertasEnviadas++;
      }

      // Llamada 1 (minuto 0): exclusiva VIP. Los reintentos los hace
      // procesarRefuerzosVip si no contesta.
      if (plan === 'vip' && esApertura && puedeLlamar(s)) {
        llamadasIntentadas++;
        await llamarVip(s, { clave: cambio.clave, municipio: cambio.municipio, estado: estadoNombreReal, intento: 1 });
        llamadasPorCliente[s.id] = 1;
      }
    }

    // Secuencia de recordatorios reforzados VIP, por cliente (la avanza
    // procesarRefuerzosVip en cada tick de 5 min). Si el municipio deja de
    // estar Abierto, la secuencia se corta.
    if (plan === 'vip') {
      if (esApertura) {
        refuerzos[cambio.clave] = {
          primera: ahora, municipio: cambio.municipio, estado: estadoNombreReal,
          usuarios: Object.fromEntries(destinatarios.map(s => [s.id, { tg: 0, correo: 0, llamadas: llamadasPorCliente[s.id] || 0 }]))
        };
      } else {
        delete refuerzos[cambio.clave];
      }
    }
  }

  if (plan === 'vip') {
    await store.setJSON(claveRefuerzos, refuerzos);
  }

  await volcarEnvios();
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
  // Latido del cron: el admin muestra "Monitoreo detenido" si deja de
  // actualizarse (así una falla al arrancar ya no pasa desapercibida).
  await store.set('cron_ultimo_tick', new Date().toISOString());

  const cierre = await cerrarPeriodoSiVencido(config, store);
  if (cierre.cerrado) {
    return { ok: true, activo: false, motivo: 'Periodo vencido — suscriptores archivados automáticamente.', ...cierre };
  }

  if (!dentroDelPeriodo(config)) {
    return { ok: true, activo: false, motivo: 'Fuera del periodo de monitoreo global — no se procesó nada.' };
  }

  const degradados = await degradarVipVencidos();
  const vipDegradados = degradados.length;
  // Estación 9 del flujo: aviso de vencimiento con invitación a renovar.
  if (degradados.length) {
    const flujoV = await cargarFlujo();
    if (flujoV.activo('vencimiento_vip')) {
      const precioTxt = formatoMxn((await precioVip()).vip_precio);
      for (const s of degradados) {
        await enviarEstacion('vencimiento_vip', s, CONSTRUCTORES.vencimiento_vip(flujoV, s, { precioTxt }));
      }
      await volcarEnvios();
    }
  }

  // Recordatorios reforzados VIP: en cada tick de 5 min.
  const refuerzosVip = await procesarRefuerzosVip(store);

  const frecVip = config.vip_frecuencia_min || DEFAULT_VIP_MIN;
  const frecFree = config.free_frecuencia_min || DEFAULT_FREE_MIN;

  const [vipLeToca, freeLeToca] = await Promise.all([
    leToca('vip', frecVip, store),
    leToca('free', frecFree, store)
  ]);

  if (!vipLeToca && !freeLeToca) {
    return { ok: true, activo: true, motivo: 'A ningún plan le tocaba revisar todavía en este tick.', vipDegradados, refuerzosVip };
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

  return { ok: true, activo: true, vipDegradados, refuerzosVip, vip, free };
}

export default async () => {
  try {
    const resultado = await conTimeout(
      ejecutarRevisionNacional(),
      20000,
      'La revisión nacional tardó demasiado (más de 20 segundos) y se canceló'
    );
    try {
      await getStore('jcf-nacional').setJSON('cron_ultimo_resultado', {
        fecha: new Date().toISOString(), activo: resultado.activo, motivo: resultado.motivo || null,
        vip: resultado.vip?.reviso ? { cambios: resultado.vip.cambiosDetectados, alertas: resultado.vip.alertasEnviadas } : null,
        free: resultado.free?.reviso ? { cambios: resultado.free.cambiosDetectados, alertas: resultado.free.alertasEnviadas } : null
      });
    } catch {}
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
