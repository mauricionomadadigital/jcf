// netlify/functions/lib/flujo-disparo.mjs
// "Disparar ahora" de Admin > Flujo: reenvía manualmente el mensaje de una
// estación, a TODOS los clientes que están en ella o a UNO específico.
// Usa los mismos constructores que el envío automático (flujo-mensajes).
// Nunca hace la llamada de Talkyria: el disparo manual es solo Telegram/correo.

import { cargarFlujo } from './flujo.mjs';
import { CONSTRUCTORES, enviarEstacion, volcarEnvios, prepararRecuperacion } from './flujo-mensajes.mjs';
import { descargarCatalogo, estadoTexto, normalizar } from './dtmlp.mjs';
import { precioVip, formatoMxn } from './precio.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const headers = (extra = {}) => ({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra });

// Por estación: a quién le toca "a todos", si necesita el estado real del
// municipio (catálogo del gobierno) y si es correo transaccional (forzar).
export const DISPAROS = {
  bienvenida_gratis: { todos: 'Clientes activos que todavía NO vinculan su Telegram — les llega otra vez el correo con el botón del bot.', filtro: (s) => !s.telegram_chat_id, forzar: true },
  telegram_vinculado: { todos: 'Clientes activos con Telegram vinculado.', filtro: (s) => !!s.telegram_chat_id },
  seguimos_vigilando: { todos: 'Clientes con Telegram cuyo municipio sigue Cerrado.', filtro: (s, est) => !!s.telegram_chat_id && est === 'Cerrado', catalogo: true },
  cuenta_regresiva: { todos: 'Todos los clientes activos (usa la fecha estimada de apertura de Configuración).', filtro: () => true, fecha: true },
  apertura: { todos: 'Clientes cuyo municipio está ABIERTO ahora mismo (Telegram y correo, sin llamada).', filtro: (s, est) => est === 'Abierto', catalogo: true },
  cambio_estado: { todos: 'Clientes cuyo municipio está en "Meta alcanzada" ahora mismo.', filtro: (s, est) => est === 'Meta alcanzada', catalogo: true },
  pago_aprobado: { todos: 'Clientes VIP activos — les llega otra vez la confirmación de VIP.', filtro: (s) => s.plan === 'vip', forzar: true },
  vencimiento_vip: { todos: 'Clientes Gratis que alguna vez fueron VIP (invitación a renovar).', filtro: (s) => s.plan !== 'vip' && !!s.vip_started_at },
  recuperar_password: { soloUno: 'Solo a un cliente: le llega un link nuevo para elegir contraseña.', forzar: true }
};
export const SIN_DISPARO = {
  recordatorio_vip: 'Es una serie automática ligada a una apertura en curso. Para reenviar el aviso usa "¡Abrió tu municipio!".',
  soporte: 'Son respuestas automáticas a lo que el cliente escribe; para escribirle usa Mensajes > Soporte VIP.',
  bot_avisos: 'Son respuestas del bot a lo que el cliente hace; no se envían por iniciativa propia.'
};

async function suscriptoresActivos() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?activo=eq.true&select=*&limit=5000`, { headers: headers() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Estado real del municipio de cada suscriptor según el catálogo oficial.
async function estadosReales(suscriptores) {
  const { inicio, detmun } = await descargarCatalogo();
  const idPorEstado = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
  return new Map(suscriptores.map(s => {
    const idedo = idPorEstado.get(normalizar(s.estado));
    const m = (detmun || []).find(x => Number(x.edo) === idedo && normalizar(x.lmun) === normalizar(s.municipio));
    return [s.id, m ? estadoTexto(m.status) : 'Desconocido'];
  }));
}

async function datosExtra(clave, s, est) {
  if (clave === 'seguimos_vigilando') return { hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' }) };
  if (clave === 'cuenta_regresiva') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=fecha_estimada_apertura&limit=1`, { headers: headers() });
    const fecha = (await r.json())?.[0]?.fecha_estimada_apertura;
    const hoy = new Date().toISOString().slice(0, 10);
    if (!fecha || fecha <= hoy) throw new Error('No hay fecha estimada de apertura en el futuro (Configuración).');
    return { dias: Math.ceil((new Date(fecha) - new Date(hoy)) / 86400000), precioTxt: formatoMxn((await precioVip()).vip_precio) };
  }
  if (clave === 'vencimiento_vip') return { precioTxt: formatoMxn((await precioVip()).vip_precio) };
  if (clave === 'apertura') return { municipio: s.municipio, estado: s.estado };
  if (clave === 'cambio_estado') return { municipio: s.municipio, estado: s.estado, estadoNuevo: est || 'Meta alcanzada' };
  if (clave === 'recuperar_password') return prepararRecuperacion(s);
  return {};
}

// Vista previa de "a todos": cuántos y quiénes (sin enviar nada).
export async function destinatarios(clave) {
  const d = DISPAROS[clave];
  if (!d || d.soloUno) return { aplica: !!d, soloUno: !!d?.soloUno, total: 0, lista: [] };
  if (d.fecha) await datosExtra(clave); // valida que haya fecha de apertura futura
  const todos = await suscriptoresActivos();
  const est = d.catalogo ? await estadosReales(todos) : null;
  const lista = todos.filter(s => d.filtro(s, est?.get(s.id)));
  return { aplica: true, total: lista.length, lista, estados: est };
}

async function registrarDisparo(fila) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_disparos`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(fila)
  });
  if (!res.ok) return null;
  return (await res.json())[0];
}
async function actualizarDisparo(id, cambios) {
  if (!id) return;
  await fetch(`${SUPABASE_URL}/rest/v1/flujo_disparos?id=eq.${id}`, {
    method: 'PATCH', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(cambios)
  });
}

async function enviarA(clave, flujo, s, est, comun) {
  const d = DISPAROS[clave];
  const extra = comun || await datosExtra(clave, s, est);
  const mensaje = CONSTRUCTORES[clave](flujo, s, extra);
  const r = await enviarEstacion(clave, s, mensaje, { forzar: !!d.forzar, manual: true });
  const algo = r.telegram !== null || r.correo !== null;
  return { ok: !!(r.telegram || r.correo), algo, r };
}

// A UNO: síncrono (lo llama admin-api). Ignora el filtro de la estación
// (el admin decide), pero respeta que el cliente tenga el canal.
export async function dispararUno(clave, suscriptorId) {
  const d = DISPAROS[clave];
  if (!d) throw new Error(SIN_DISPARO[clave] || 'Esta estación no se puede disparar.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${Number(suscriptorId)}&select=*&limit=1`, { headers: headers() });
  const [s] = await res.json();
  if (!s) throw new Error('Ese cliente ya no existe.');
  const est = d.catalogo ? (await estadosReales([s])).get(s.id) : null;
  const flujo = await cargarFlujo();
  const { ok, algo, r } = await enviarA(clave, flujo, s, est);
  await volcarEnvios();
  await registrarDisparo({ clave, alcance: 'uno', suscriptor_id: s.id, destinatarios: 1, enviados: ok ? 1 : 0, fallidos: ok ? 0 : 1, estado: 'terminado', terminado_en: new Date().toISOString(), detalle: s.email });
  if (!algo) throw new Error('Ese cliente no tiene el canal de esta estación (Telegram sin vincular o canal apagado).');
  return { email: s.email, telegram: r.telegram, correo: r.correo };
}

// A TODOS: lo corre la Background Function (puede tardar minutos).
export async function dispararTodos(clave) {
  const d = DISPAROS[clave];
  if (!d || d.soloUno) throw new Error('Esta estación no se dispara a todos.');
  const flujo = await cargarFlujo();
  const { lista, estados } = await destinatarios(clave);
  // Datos iguales para todos (fecha de apertura, precio): se calculan una vez.
  const comun = ['cuenta_regresiva', 'vencimiento_vip', 'seguimos_vigilando'].includes(clave) ? await datosExtra(clave) : null;
  const disparo = await registrarDisparo({ clave, alcance: 'todos', destinatarios: lista.length });
  let enviados = 0, fallidos = 0;
  try {
    for (const s of lista) {
      try {
        const { ok, algo } = await enviarA(clave, flujo, s, estados?.get(s.id), comun);
        if (ok) enviados++; else if (algo) fallidos++;
      } catch { fallidos++; }
      if ((enviados + fallidos) % 25 === 0) { await volcarEnvios(); await actualizarDisparo(disparo?.id, { enviados, fallidos }); }
      await new Promise(r => setTimeout(r, 50)); // ~20/seg, bajo el límite de Telegram
    }
    await volcarEnvios();
    await actualizarDisparo(disparo?.id, { enviados, fallidos, estado: 'terminado', terminado_en: new Date().toISOString() });
  } catch (err) {
    await volcarEnvios();
    await actualizarDisparo(disparo?.id, { enviados, fallidos, estado: 'error', detalle: err.message, terminado_en: new Date().toISOString() });
  }
}

// --- Fase 3: contadores por estación (últimos 7 días) ------------------------
export async function estadisticas() {
  const desde = new Date(Date.now() - 7 * 86400000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_envios?created_at=gte.${encodeURIComponent(desde)}&select=clave,canal,ok,manual,created_at&order=created_at.desc&limit=20000`, { headers: headers() });
  if (!res.ok) return {};
  const filas = await res.json();
  const por = {};
  for (const f of filas) {
    const e = por[f.clave] || (por[f.clave] = { telegram: 0, correo: 0, fallidos: 0, manuales: 0, ultimo: f.created_at });
    if (f.ok) e[f.canal]++; else e.fallidos++;
    if (f.manual) e.manuales++;
  }
  return por;
}

export async function historialDisparos(clave) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_disparos?clave=eq.${encodeURIComponent(clave)}&select=*&order=created_at.desc&limit=10`, { headers: headers() });
  return res.ok ? res.json() : [];
}
