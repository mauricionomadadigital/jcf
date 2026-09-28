// netlify/functions/lib/flujo-admin.mjs
// Lado admin de Admin > Flujo: leer el estado de cada estación, guardar
// cambios (validados), restaurar de fábrica y mandar pruebas al admin.
// Lo usa admin-api.mjs; el catálogo y los valores de fábrica viven en
// lib/flujo.mjs.

import { ESTACIONES, POR_CLAVE, EJEMPLO, VARIABLES, MAX_TEXTO, render, textoAHtml, cargarFlujo } from './flujo.mjs';
import { enviarCorreo, plantillaBienvenida, plantillaUpgradeVinculado } from './email.mjs';
import { enviarTelegramTexto } from './soporte.mjs';
import { DISPAROS, SIN_DISPARO, estadisticas } from './flujo-disparo.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID;
export const ADMIN_EMAIL_DEFECTO = process.env.ADMIN_EMAIL || 'maurixcasas@gmail.com';

const headers = (extra = {}) => ({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra });

export async function estadoFlujo() {
  const [f, stats] = await Promise.all([cargarFlujo(), estadisticas()]);
  return {
    variables: VARIABLES,
    ejemplo: EJEMPLO,
    admin: { telegram: !!ADMIN_TELEGRAM_CHAT_ID, correo: ADMIN_EMAIL_DEFECTO },
    estaciones: ESTACIONES.map(e => {
      const ov = f.overrides[e.clave] || {};
      return {
        ...e,
        activo: f.activo(e.clave),
        actualizado: ov.updated_at || null,
        // Fase 2: qué permite "Disparar ahora". Fase 3: envíos de los últimos 7 días.
        disparo: DISPAROS[e.clave] ? { todos: DISPAROS[e.clave].todos || null, soloUno: DISPAROS[e.clave].soloUno || null } : { no: SIN_DISPARO[e.clave] || 'No aplica.' },
        stats: stats[e.clave] || null,
        campos: e.campos.map(c => {
          const guardado = ov.textos?.[c.clave];
          const personalizado = typeof guardado === 'string' && guardado.trim() !== '' && guardado !== c.defecto;
          return { ...c, valor: personalizado ? guardado : c.defecto, personalizado };
        }),
        params: (e.params || []).map(p => ({ ...p, valor: f.param(e.clave, p.clave), personalizado: f.param(e.clave, p.clave) !== p.defecto }))
      };
    })
  };
}

// Guarda SOLO lo que difiere de fábrica; si ya no queda nada distinto,
// borra la fila (equivale a restaurar).
export async function guardarEstacion({ clave, activo, textos = {}, params = {} }) {
  const e = POR_CLAVE[clave];
  if (!e || e.proximamente) throw new Error('Estación no válida.');
  const fila = { clave, activo: null, textos: {}, params: {}, updated_at: new Date().toISOString() };

  if (e.apagable && activo === false) fila.activo = false;

  for (const c of e.campos) {
    const v = textos[c.clave];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`"${c.etiqueta}" debe ser texto.`);
    if (v.length > MAX_TEXTO) throw new Error(`"${c.etiqueta}" pasa de ${MAX_TEXTO} caracteres.`);
    if (c.tipo === 'asunto' && v.length > 200) throw new Error('El asunto pasa de 200 caracteres.');
    if (v.trim() && v !== c.defecto) fila.textos[c.clave] = v;
  }
  for (const p of e.params || []) {
    const v = params[p.clave];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < p.min || n > p.max) throw new Error(`"${p.etiqueta}" debe estar entre ${p.min} y ${p.max}.`);
    if (n !== p.defecto) fila.params[p.clave] = n;
  }

  const sinCambios = fila.activo === null && !Object.keys(fila.textos).length && !Object.keys(fila.params).length;
  if (sinCambios) return restaurarEstacion(clave);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_config?on_conflict=clave`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(fila)
  });
  if (!res.ok) throw new Error('No se pudo guardar (¿ya corriste sql/009?): ' + (await res.text()));
}

export async function restaurarEstacion(clave) {
  const filtro = clave ? `clave=eq.${encodeURIComponent(clave)}` : 'clave=not.is.null';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_config?${filtro}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) throw new Error(await res.text());
}

function correoVistaPrevia(e, cuerpos) {
  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#0a1220;color:#eef2f9;border-radius:16px;">
      <h1 style="color:#34d399;margin:0 0 6px;">🔔 Monitor JCF</h1>
      ${cuerpos.map(t => `<p style="color:#dbe4f0;line-height:1.55;">${textoAHtml(t)}</p>`).join('')}
    </div>`;
}

// Manda la estación al admin con datos de ejemplo (y los textos que se
// pasen, aunque aún no estén guardados): Telegram a su chat, correo a
// `correo`. Devuelve qué se pudo entregar.
export async function probarEstacion({ clave, textos = {}, correo }) {
  const e = POR_CLAVE[clave];
  if (!e || e.proximamente) throw new Error('Estación no válida.');
  const valor = (c) => (typeof textos[c.clave] === 'string' && textos[c.clave].trim() ? textos[c.clave] : c.defecto);
  // Solo las variables que esta estación tiene al enviar de verdad; las
  // demás se quedan tal cual, igual que le llegarían al cliente.
  const ejemplo = Object.fromEntries(e.variables.map(v => [v, EJEMPLO[v]]));
  const txt = (campo) => render(valor(e.campos.find(c => c.clave === campo)), ejemplo);
  const resultado = { telegram: null, correo: null };

  const camposTg = e.campos.filter(c => c.tipo === 'telegram');
  if (camposTg.length) {
    if (!ADMIN_TELEGRAM_CHAT_ID) resultado.telegram = 'Falta ADMIN_TELEGRAM_CHAT_ID en Netlify.';
    else {
      const cuerpo = `🧪 PRUEBA · ${e.num}. ${e.titulo}\n\n` + camposTg.map(c => `— ${c.etiqueta} —\n${render(valor(c), ejemplo)}`).join('\n\n');
      const r = await enviarTelegramTexto(ADMIN_TELEGRAM_CHAT_ID, cuerpo.slice(0, 4000));
      resultado.telegram = r.ok ? 'ok' : `No llegó: ${r.description} (¿ya le diste Iniciar al bot?)`;
    }
  }

  if (e.campos.some(c => c.tipo === 'correo' || c.tipo === 'asunto')) {
    const para = String(correo || ADMIN_EMAIL_DEFECTO).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para)) throw new Error('Correo de prueba no válido.');
    const link = 'https://t.me/Monitormex247Bot?start=PRUEBA';
    const envios = [];
    if (clave === 'bienvenida_gratis') {
      envios.push([txt('asunto'), plantillaBienvenida({ plan: 'free', municipio: EJEMPLO.municipio, estado: EJEMPLO.estado, telegramLink: link, intro: txt('intro'), paso: txt('paso') })]);
    } else if (clave === 'pago_aprobado') {
      envios.push([txt('asunto_nuevo'), plantillaBienvenida({ plan: 'vip', municipio: EJEMPLO.municipio, estado: EJEMPLO.estado, telegramLink: link, intro: txt('intro_nuevo') })]);
      envios.push([txt('asunto_vinculado'), plantillaUpgradeVinculado({ municipio: EJEMPLO.municipio, estado: EJEMPLO.estado, intro: txt('intro_vinculado') })]);
    } else {
      const asunto = e.campos.find(c => c.tipo === 'asunto');
      const cuerpos = e.campos.filter(c => c.tipo !== 'asunto').map(c => render(valor(c), ejemplo));
      envios.push([asunto ? txt(asunto.clave) : e.titulo, correoVistaPrevia(e, cuerpos)]);
    }
    for (const [asunto, html] of envios) await enviarCorreo(para, `[PRUEBA] ${asunto}`, html);
    resultado.correo = `ok (${envios.length} a ${para})`;
  }
  return resultado;
}
