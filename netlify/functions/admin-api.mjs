// netlify/functions/admin-api.mjs
// Todas las acciones del panel de administrador pasan por aquí,
// protegidas con ADMIN_PASSWORD en el header x-admin-password.

import { normalizar, estadoTexto, descargarCatalogo, enviarTelegram } from './lib/dtmlp.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headersSupabase() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function getConfig() {
  const data = await sb('configuracion?id=eq.1&select=*&limit=1');
  return data && data[0] ? data[0] : null;
}

async function setConfig(cambios) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(cambios)
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data[0];
}

async function listarSuscriptores() {
  return sb('suscriptores?select=*&order=created_at.desc&limit=500');
}

function buscarEstadoReal(estadoIdPorNombre, detmun, estadoNombre, municipioNombre) {
  const idedo = estadoIdPorNombre.get(normalizar(estadoNombre));
  const m = (detmun || []).find(x => Number(x.edo) === idedo && normalizar(x.lmun) === normalizar(municipioNombre));
  return m ? estadoTexto(m.status) : 'Desconocido (no encontrado en el catálogo)';
}

async function testTodos() {
  const [suscriptores, { inicio, detmun }] = await Promise.all([listarSuscriptores(), descargarCatalogo()]);
  const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
  const conChat = suscriptores.filter(s => s.activo && s.telegram_chat_id);

  let enviados = 0;
  for (const s of conChat) {
    const real = buscarEstadoReal(estadoIdPorNombre, detmun, s.estado, s.municipio);
    const ok = await enviarTelegram(
      TELEGRAM_BOT_TOKEN,
      s.telegram_chat_id,
      `🧪 Revisión en vivo — Monitor JCF\n\n${s.municipio}, ${s.estado}\nEstado real ahora mismo: ${real}\n\n(Esta es una consulta real al sistema del gobierno, no un mensaje de prueba genérico.)`
    );
    if (ok) enviados++;
  }
  return { totalConTelegram: conChat.length, enviados };
}

async function testMunicipio(estado, municipio) {
  const [suscriptores, { inicio, detmun }] = await Promise.all([listarSuscriptores(), descargarCatalogo()]);
  const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
  const real = buscarEstadoReal(estadoIdPorNombre, detmun, estado, municipio);

  const destinatarios = suscriptores.filter(
    s => s.activo && s.telegram_chat_id &&
      normalizar(s.estado) === normalizar(estado) &&
      normalizar(s.municipio) === normalizar(municipio)
  );
  let enviados = 0;
  for (const s of destinatarios) {
    const ok = await enviarTelegram(
      TELEGRAM_BOT_TOKEN,
      s.telegram_chat_id,
      `🧪 Revisión en vivo — Monitor JCF\n\n${municipio}, ${estado}\nEstado real ahora mismo: ${real}\n\n(Esta es una consulta real al sistema del gobierno, no un mensaje de prueba genérico.)`
    );
    if (ok) enviados++;
  }
  return { encontrados: destinatarios.length, enviados, estadoReal: real };
}

// --- Resumen general -----------------------------------------------------
async function calcularStats() {
  const suscriptores = await listarSuscriptores();
  const activos = suscriptores.filter(s => s.activo);
  const vip = activos.filter(s => s.plan === 'vip');
  const free = activos.filter(s => s.plan === 'free');

  const haceUnaSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const nuevosSemana = activos.filter(s => new Date(s.created_at).getTime() >= haceUnaSemana).length;

  const municipiosUnicos = new Set(activos.map(s => normalizar(s.estado) + '|' + normalizar(s.municipio)));

  const ingresos = vip.reduce((sum, s) => sum + (Number(s.monto) || 0), 0);

  // Conversiones VIP por día, últimos 7 días.
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const clave = d.toISOString().slice(0, 10);
    const nombre = d.toLocaleDateString('es-MX', { weekday: 'short' });
    const nuevosVip = vip.filter(s => (s.vip_started_at || s.created_at || '').slice(0, 10) === clave);
    dias.push({
      dia: nombre,
      nuevosVip: nuevosVip.length,
      ingreso: nuevosVip.reduce((sum, s) => sum + (Number(s.monto) || 0), 0)
    });
  }

  return {
    usuariosActivos: activos.length,
    nuevosSemana,
    vip: vip.length,
    free: free.length,
    municipiosVigilados: municipiosUnicos.size,
    ingresosPeriodo: ingresos,
    conversion7dias: dias
  };
}

// --- Monitoreos activos ---------------------------------------------------
function textoFrecuencia(min) {
  if (min % 60 === 0) { const h = min / 60; return h === 1 ? '1 hora' : `${h} horas`; }
  return `${min} minutos`;
}
async function calcularMonitoreos() {
  const [suscriptores, { inicio, detmun }, config] = await Promise.all([listarSuscriptores(), descargarCatalogo(), getConfig()]);
  const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
  const activos = suscriptores.filter(s => s.activo);
  const frecVip = textoFrecuencia(config?.vip_frecuencia_min || 10);
  const frecFree = textoFrecuencia(config?.free_frecuencia_min || 120);

  const grupos = new Map();
  for (const s of activos) {
    const clave = normalizar(s.estado) + '|' + normalizar(s.municipio);
    if (!grupos.has(clave)) {
      grupos.set(clave, { estado: s.estado, municipio: s.municipio, vip: 0, free: 0 });
    }
    const g = grupos.get(clave);
    if (s.plan === 'vip') g.vip++; else g.free++;
  }

  return [...grupos.values()].map(g => ({
    ...g,
    resultado: buscarEstadoReal(estadoIdPorNombre, detmun, g.estado, g.municipio),
    // Si hay al menos un VIP en el grupo, ese municipio ya se revisa a la
    // cadencia de VIP (más rápida) además de la de Free.
    frecuencia: g.vip > 0 ? frecVip : frecFree
  })).sort((a, b) => (b.vip + b.free) - (a.vip + a.free));
}

// --- Pagos -----------------------------------------------------------------
async function calcularPagos() {
  const suscriptores = await sb('suscriptores?plan=eq.vip&select=id,email,municipio,estado,monto,cycle_number,discount_percent,vip_started_at,created_at&order=created_at.desc&limit=200');
  return suscriptores.map(s => {
    const inicio = s.vip_started_at || s.created_at;
    const finaliza = inicio ? new Date(new Date(inicio).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString() : null;
    return { ...s, finaliza };
  });
}

// --- Referidos ---------------------------------------------------------------
async function calcularReferidos() {
  const [conCodigo, clicks] = await Promise.all([
    sb('suscriptores?referral_code=not.is.null&select=email,referral_code,created_at'),
    sb('referral_clicks?select=code,clics')
  ]);
  const todos = await sb('suscriptores?referred_by=not.is.null&select=plan,referred_by');
  const clicksPorCodigo = new Map(clicks.map(c => [c.code, c.clics]));

  const filas = conCodigo.map(u => {
    const registros = todos.filter(r => r.referred_by === u.referral_code);
    const vip = registros.filter(r => r.plan === 'vip').length;
    const clics = clicksPorCodigo.get(u.referral_code) || 0;
    return {
      email: u.email,
      codigo: u.referral_code,
      clics,
      registros: registros.length,
      vip,
      conversion: clics > 0 ? Math.round((registros.length / clics) * 1000) / 10 : 0
    };
  }).filter(f => f.clics > 0 || f.registros > 0)
    .sort((a, b) => b.registros - a.registros);

  return {
    filas,
    totalClics: clicks.reduce((s, c) => s + c.clics, 0),
    totalRegistros: todos.length,
    totalCompradores: todos.filter(r => r.plan === 'vip').length
  };
}

// --- Llamadas ----------------------------------------------------------------
async function calcularLlamadas() {
  return sb('llamadas?select=*&order=created_at.desc&limit=100');
}

// --- Alertas / historial de cambios -------------------------------------------
async function calcularAlertas() {
  const [historial, pendientes] = await Promise.all([
    sb('historial_cambios?select=*&order=created_at.desc&limit=50'),
    sb('suscriptores?activo=eq.true&telegram_chat_id=is.null&select=id,email')
  ]);
  return { historial, pendientesTelegram: pendientes.length };
}

// --- Fallos silenciosos (crons, Telegram, correo) -----------------------------
async function calcularFallos() {
  return sb('fallos_sistema?select=*&order=created_at.desc&limit=100');
}

// --- Cuentas archivadas (para exportar por fecha de cierre) -------------------
async function calcularArchivados() {
  return sb('suscriptores?activo=eq.false&select=email,municipio,estado,plan,discount_percent,periodos_inactivo,archivado_en,created_at&order=archivado_en.desc.nullslast&limit=1000');
}

export default async (req) => {
  if (req.headers.get('x-admin-password') !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'GET' && action === 'config') return json({ ok: true, config: await getConfig() });
    if (req.method === 'GET' && action === 'suscriptores') return json({ ok: true, suscriptores: await listarSuscriptores() });
    if (req.method === 'GET' && action === 'stats') return json({ ok: true, stats: await calcularStats() });
    if (req.method === 'GET' && action === 'monitoreos') return json({ ok: true, monitoreos: await calcularMonitoreos() });
    if (req.method === 'GET' && action === 'pagos') return json({ ok: true, pagos: await calcularPagos() });
    if (req.method === 'GET' && action === 'referidos') return json({ ok: true, ...(await calcularReferidos()) });
    if (req.method === 'GET' && action === 'llamadas') return json({ ok: true, llamadas: await calcularLlamadas() });
    if (req.method === 'GET' && action === 'alertas') return json({ ok: true, ...(await calcularAlertas()) });
    if (req.method === 'GET' && action === 'fallos') return json({ ok: true, fallos: await calcularFallos() });
    if (req.method === 'GET' && action === 'archivados') return json({ ok: true, archivados: await calcularArchivados() });

    if (req.method === 'POST' && action === 'config') {
      const body = await req.json();
      const permitido = {};
      [
        'registro_abierto', 'periodo_inicio', 'periodo_fin', 'fecha_estimada_apertura',
        'encuesta_fecha', 'siguiente_ciclo_fecha', 'video1_url', 'video2_url',
        'mostrar_lectura_real', 'incluir_guia_documentos', 'enviar_encuesta_final',
        'vip_frecuencia_min', 'free_frecuencia_min'
      ].forEach(k => { if (body[k] !== undefined) permitido[k] = body[k]; });
      return json({ ok: true, config: await setConfig(permitido) });
    }

    if (req.method === 'POST' && action === 'test-todos') return json({ ok: true, resultado: await testTodos() });

    if (req.method === 'POST' && action === 'test-municipio') {
      const body = await req.json();
      return json({ ok: true, resultado: await testMunicipio(body.estado, body.municipio) });
    }

    // Baja forzada desde el admin: mismo efecto que "Dar de baja" del
    // propio usuario — borra la fila por completo (Telegram, correo y
    // alertas se cortan solos porque ya no existe a quién avisarle).
    if (req.method === 'POST' && action === 'eliminar-usuario') {
      const { id } = await req.json();
      if (!id) return json({ error: 'Falta el id del suscriptor.' }, 400);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
        method: 'DELETE',
        headers: headersSupabase()
      });
      if (!res.ok) return json({ error: await res.text() }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('Error admin-api:', err.message);
    return json({ error: err.message }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
