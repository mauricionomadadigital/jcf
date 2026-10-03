// netlify/functions/baja.mjs
// Link de un clic para darse de baja desde un mensaje de Telegram o
// correo, sin necesitar iniciar sesión. Se identifica con el mismo
// telegram_token único que ya trae cada suscriptor (el mismo que se usa
// para el link de "vincular tu Telegram") — no expone nada que no supiera
// ya la persona dueña de ese correo.
//
// Abrir el link (GET) SOLO muestra una página de confirmación; la cuenta
// se borra al presionar el botón (POST). Antes el GET borraba de una vez,
// y las vistas previas de links de Telegram y los filtros de seguridad de
// correo (que "abren" los links solos) podían borrar cuentas sin que el
// cliente hiciera nada.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    ...extra
  };
}

function pagina(titulo, mensaje, extra = '') {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo} — Monitor JCF</title>
  <style>
    body{font-family:sans-serif;background:#0a1220;color:#eef2f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
    .card{max-width:420px;background:#101c30;border:1px solid rgba(52,211,153,.25);border-radius:16px;padding:32px;text-align:center;}
    h1{color:#34d399;font-size:20px;margin:0 0 12px;}
    p{color:#9aa7bd;line-height:1.5;}
    a{color:#34d399;}
    button{margin-top:18px;background:#c0491f;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:15px;font-weight:700;cursor:pointer;}
  </style></head>
  <body><div class="card"><h1>🔔 Monitor JCF</h1><p>${mensaje}</p>${extra}</div></body></html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default async (req) => {
  const url = new URL(req.url);
  const token = (url.searchParams.get('token') || '').trim();

  if (!token) {
    return html(pagina('Enlace inválido', 'Este enlace de baja no es válido.'), 400);
  }

  try {
    const buscar = await fetch(
      `${SUPABASE_URL}/rest/v1/suscriptores?telegram_token=eq.${encodeURIComponent(token)}&select=id&limit=1`,
      { headers: headersSupabase() }
    );
    const filas = await buscar.json();
    const suscriptor = Array.isArray(filas) && filas[0] ? filas[0] : null;

    if (!suscriptor) {
      return html(pagina('Ya no existe', 'Esta cuenta ya no existe — probablemente ya te habías dado de baja antes.'));
    }

    // GET = solo confirmar. Nada se borra hasta presionar el botón.
    if (req.method !== 'POST') {
      const t = token.replace(/[^0-9a-zA-Z-]/g, '');
      return html(pagina('¿Darte de baja?',
        'Si confirmas, se borra tu cuenta y dejarás de recibir avisos cuando abra tu municipio. Si solo quieres menos mensajes, puedes apagar canales desde tu panel.',
        `<form method="POST" action="/.netlify/functions/baja?token=${t}"><button type="submit">Sí, darme de baja</button></form>
         <p style="margin-top:14px;font-size:13px;"><a href="/panel.html">No, volver a mi panel</a></p>`));
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/suscriptores?id=eq.${suscriptor.id}`, {
      method: 'DELETE',
      headers: headersSupabase()
    });
    if (!res.ok) throw new Error(await res.text());

    return html(pagina('Listo', 'Ya diste de baja tu cuenta — no volverás a recibir mensajes de Monitor JCF. Si cambias de opinión, puedes registrarte de nuevo cuando quieras.'));
  } catch (err) {
    console.error('Error en baja.mjs:', err.message);
    return html(pagina('Error', 'No se pudo procesar tu baja en este momento. Intenta de nuevo en unos minutos.'), 500);
  }
};
