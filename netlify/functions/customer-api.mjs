// netlify/functions/customer-api.mjs
// Todo lo que el cliente hace ya logueado en / pasa por aquí,
// protegido con el token de sesión (Authorization: Bearer <token>).

import { suscriptorDesdeToken, tokenDesdeRequest, verifyPassword, hashPassword } from './lib/auth.mjs';
import { normalizar, estadoTexto, descargarCatalogo } from './lib/dtmlp.mjs';
import { guardarMensaje, hiloDe, avisarAdmin, MAX_MENSAJE_SOPORTE } from './lib/soporte.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

function sinPassword(s) {
  const { password_hash, reset_token, ...resto } = s;
  return { ...resto, tiene_password: !!password_hash };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function actualizar(id, cambios) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${id}`, {
    method: 'PATCH',
    headers: headersSupabase({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(cambios)
  });
  if (!res.ok) throw new Error(await res.text());
  const [row] = await res.json();
  return row;
}

export default async (req) => {
  const suscriptor = await suscriptorDesdeToken(tokenDesdeRequest(req));
  if (!suscriptor) return json({ error: 'Sesión inválida o vencida.' }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'GET' && action === 'estado-real') {
      const { inicio, detmun } = await descargarCatalogo();
      const estadoIdPorNombre = new Map((inicio || []).map(e => [normalizar(e.edo), e.idedo]));
      const idedo = estadoIdPorNombre.get(normalizar(suscriptor.estado));
      const m = (detmun || []).find(x => Number(x.edo) === idedo && normalizar(x.lmun) === normalizar(suscriptor.municipio));
      return json({ ok: true, estadoReal: m ? estadoTexto(m.status) : 'Desconocido' });
    }

    if (req.method === 'POST' && action === 'municipio') {
      const { estado, municipio } = await req.json();
      if (!estado || !municipio) return json({ error: 'Elige estado y municipio.' }, 400);
      const sinCambio = estado === suscriptor.estado && municipio === suscriptor.municipio;
      if (!sinCambio && (suscriptor.cambios_municipio_restantes || 0) <= 0) {
        return json({ error: 'Ya usaste tus 3 cambios de estado/municipio permitidos para esta cuenta.' }, 400);
      }
      const cambios = { estado, municipio };
      if (!sinCambio) cambios.cambios_municipio_restantes = suscriptor.cambios_municipio_restantes - 1;
      const row = await actualizar(suscriptor.id, cambios);
      return json({ ok: true, suscriptor: sinPassword(row) });
    }

    if (req.method === 'POST' && action === 'perfil') {
      const { nombre, telefono, telefonoPrefijo } = await req.json();
      const cambios = {};
      if (nombre !== undefined) {
        const limpio = (nombre || '').trim();
        if (!limpio) return json({ error: 'Escribe tu nombre.' }, 400);
        cambios.nombre = limpio;
      }
      if (telefono !== undefined) {
        if (telefono && !/^\d{6,12}$/.test(telefono)) return json({ error: 'Escribe un teléfono válido.' }, 400);
        cambios.phone = telefono || null;
      }
      if (telefonoPrefijo !== undefined) cambios.telefono_prefijo = telefonoPrefijo || '+52';
      const row = await actualizar(suscriptor.id, cambios);
      return json({ ok: true, suscriptor: sinPassword(row) });
    }

    if (req.method === 'POST' && action === 'canales') {
      const { email_enabled, telegram_enabled, call_enabled, phone } = await req.json();
      if (call_enabled && suscriptor.plan !== 'vip') {
        return json({ error: 'Las llamadas automáticas solo están disponibles en el plan VIP.' }, 400);
      }
      if (call_enabled && !/^\d{10}$/.test(phone || '')) {
        return json({ error: 'Escribe un teléfono de 10 dígitos para activar llamadas.' }, 400);
      }
      if (call_enabled && suscriptor.telefono_prefijo && suscriptor.telefono_prefijo !== '+52') {
        return json({ error: 'La llamada automática por ahora solo funciona con números de México (+52).' }, 400);
      }
      const row = await actualizar(suscriptor.id, {
        email_enabled: !!email_enabled,
        telegram_enabled: !!telegram_enabled,
        call_enabled: !!call_enabled,
        phone: phone || suscriptor.phone
      });
      return json({ ok: true, suscriptor: sinPassword(row) });
    }

    // --- Soporte (chat con el administrador) — exclusivo VIP ---------------
    if (action === 'soporte') {
      if (suscriptor.plan !== 'vip') return json({ error: 'El soporte directo es exclusivo del plan VIP.' }, 403);
      if (req.method === 'POST') {
        const { texto } = await req.json();
        const limpio = (texto || '').trim();
        if (!limpio) return json({ error: 'Escribe tu mensaje.' }, 400);
        if (limpio.length > MAX_MENSAJE_SOPORTE) return json({ error: `Máximo ${MAX_MENSAJE_SOPORTE} caracteres.` }, 400);
        await guardarMensaje({ suscriptorId: suscriptor.id, autor: 'cliente', canal: 'panel', texto: limpio });
        await avisarAdmin(suscriptor, limpio, 'panel');
      }
      return json({ ok: true, mensajes: await hiloDe(suscriptor.id) });
    }

    if (req.method === 'POST' && action === 'password') {
      const { currentPassword, newPassword } = await req.json();
      // Cuenta creada con Google sin contraseña: la primera se fija sin
      // pedir "la actual" (ya está autenticada por su sesión).
      if (suscriptor.password_hash && !verifyPassword(currentPassword || '', suscriptor.password_hash)) {
        return json({ error: 'La contraseña actual no es correcta.' }, 400);
      }
      if (!newPassword || newPassword.length < 8) {
        return json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' }, 400);
      }
      if (currentPassword === newPassword) {
        return json({ error: 'La nueva contraseña debe ser diferente a la actual.' }, 400);
      }
      await actualizar(suscriptor.id, { password_hash: hashPassword(newPassword) });
      return json({ ok: true });
    }

    if (req.method === 'POST' && action === 'encuesta') {
      const { result, comment } = await req.json();
      if (result !== 'yes' && result !== 'no') return json({ error: 'Indica si lograste tu objetivo.' }, 400);
      const cambios = { survey_result: result, survey_comment: comment || null };
      // El descuento de renovación es un beneficio VIP — un plan Gratis
      // no tiene nada que renovar todavía, así que no debe poder ganarlo
      // llamando esta acción directo. Tampoco debe poder reclamarlo el
      // mismo día que se registra: solo aplica una vez que el ciclo
      // realmente llegó a su fecha de encuesta (o, si no hay fecha
      // configurada, al fin del periodo).
      if (result === 'no' && suscriptor.plan === 'vip') {
        const configRes = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=encuesta_fecha,periodo_fin&limit=1`, { headers: headersSupabase() });
        const configData = await configRes.json();
        const config = Array.isArray(configData) && configData[0] ? configData[0] : null;
        const fechaLimite = config?.encuesta_fecha || config?.periodo_fin;
        const hoy = new Date().toISOString().slice(0, 10);
        if (!fechaLimite || hoy >= fechaLimite) {
          cambios.discount_percent = suscriptor.cycle_number >= 2 ? 70 : 50;
        }
      }
      const row = await actualizar(suscriptor.id, cambios);
      return json({ ok: true, suscriptor: sinPassword(row), discountApplied: !!cambios.discount_percent });
    }

    if (req.method === 'POST' && action === 'reactivar') {
      if (suscriptor.activo) return json({ error: 'Tu cuenta ya está activa.' }, 400);
      const row = await actualizar(suscriptor.id, { activo: true, periodos_inactivo: 0, archivado_en: null });
      return json({ ok: true, suscriptor: sinPassword(row) });
    }

    // Borra el registro por completo — es lo que el usuario pidió como
    // "darse de baja": sin periodo de gracia, no se puede deshacer. Las
    // sesiones se van solas (on delete cascade) y sus llamadas pasadas
    // quedan en el admin sin nombre asociado (on delete set null).
    if (req.method === 'POST' && action === 'baja') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${suscriptor.id}`, {
        method: 'DELETE',
        headers: headersSupabase()
      });
      if (!res.ok) throw new Error(await res.text());
      return json({ ok: true });
    }

    if (req.method === 'GET' && action === 'referidos') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/suscriptores?referred_by=eq.${encodeURIComponent(suscriptor.referral_code || '')}&select=plan,created_at`,
        { headers: headersSupabase() }
      );
      const referidos = await res.json();
      const clicksRes = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_clicks?code=eq.${encodeURIComponent(suscriptor.referral_code || '')}&select=clics&limit=1`,
        { headers: headersSupabase() }
      );
      const clicksData = await clicksRes.json();
      return json({
        ok: true,
        codigo: suscriptor.referral_code,
        clics: clicksData[0]?.clics || 0,
        registros: referidos.length,
        vip: referidos.filter(r => r.plan === 'vip').length
      });
    }

    return json({ error: 'Acción no reconocida' }, 400);
  } catch (err) {
    console.error('Error customer-api:', err.message);
    return json({ error: err.message }, 500);
  }
};
