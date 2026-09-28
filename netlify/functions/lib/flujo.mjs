// netlify/functions/lib/flujo.mjs
// Catálogo del FLUJO DEL CLIENTE: cada "estación" donde el sistema manda
// algo, con su condición, sus textos y sus parámetros DE FÁBRICA. Es la
// única fuente de esos valores: las funciones que envían mensajes leen de
// aquí (con los cambios del admin encima) y el panel admin > Flujo lo
// muestra tal cual. Lo que el admin edita vive en la tabla flujo_config
// (sql/009); si no hay fila para una estación, se usa lo de aquí.
//
// Los textos aceptan variables {asi}; ver `variables` de cada estación.
// Telegram va en texto plano; en correo el texto se escapa y los saltos de
// línea se vuelven <br> dentro del diseño fijo de cada plantilla.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const V = {
  nombre: 'Nombre del cliente',
  municipio: 'Municipio que monitorea',
  estado: 'Estado',
  hora: 'Hora de la revisión (CDMX)',
  faltan_dias: '"3 días" / "1 día"',
  precio: 'Precio VIP vigente, ej. $209 MXN',
  link_vip: 'Link al checkout VIP',
  link_panel: 'Link al panel del cliente',
  link_soporte: 'Link al chat de soporte del panel',
  estado_nuevo: 'Nuevo estado del municipio',
  n: 'Número de recordatorio',
  total: 'Total de recordatorios'
};

export const EJEMPLO = {
  nombre: 'Ana', municipio: 'Zapopan', estado: 'Jalisco', hora: '09:00',
  faltan_dias: '3 días', precio: '$209 MXN',
  link_vip: 'https://monitorjcf.online/checkout-vip.html',
  link_panel: 'https://monitorjcf.online/panel.html',
  link_soporte: 'https://monitorjcf.online/panel.html#soporte',
  estado_nuevo: 'Meta alcanzada', n: '2', total: '4'
};

// etapa: registro | monitoreo | apertura | vip | soporte
// apagable: false = mensaje esencial (sin él el flujo se rompe).
export const ESTACIONES = [
  {
    clave: 'bienvenida_gratis', num: 1, etapa: 'registro', icono: '✉️',
    titulo: 'Bienvenida — cuenta gratis',
    cuando: 'Se crea (o reactiva) una cuenta Gratis, con correo o con Google.',
    quien: 'El cliente que se acaba de registrar', canales: ['correo'], apagable: false,
    variables: ['nombre', 'municipio', 'estado'],
    campos: [
      { clave: 'asunto', etiqueta: 'Asunto del correo', tipo: 'asunto', defecto: 'Tu monitoreo gratuito de JCF ya está activo' },
      { clave: 'intro', etiqueta: 'Mensaje principal', tipo: 'correo', defecto: '¡Tu prueba gratuita ya quedó activa! Vamos a vigilar por ti:' },
      { clave: 'paso', etiqueta: 'Llamado a vincular Telegram', tipo: 'correo', defecto: 'Un último paso: vincula tu Telegram para recibir la alerta.' }
    ]
  },
  {
    clave: 'telegram_vinculado', num: 2, etapa: 'registro', icono: '✈️',
    titulo: 'Telegram vinculado',
    cuando: 'El cliente abre el link del bot (/start con su código).',
    quien: 'El cliente que vincula su Telegram', canales: ['telegram'], apagable: false,
    variables: ['municipio', 'estado'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje de Telegram', tipo: 'telegram', defecto: '✅ ¡Listo! Quedaste vinculado.\n\nEstamos monitoreando: {municipio}, {estado}\n\nTe avisaremos por aquí en cuanto abra.' },
      { clave: 'extra_vip', etiqueta: 'Línea extra si es VIP', tipo: 'telegram', defecto: '💬 Como eres VIP, si tienes dudas o algo no funciona, escríbenos aquí mismo en este chat.' }
    ]
  },
  {
    clave: 'seguimos_vigilando', num: 3, etapa: 'monitoreo', icono: '👀',
    titulo: '"Seguimos vigilando"',
    cuando: 'Dentro del periodo de monitoreo, mientras su municipio siga Cerrado.',
    quien: 'Gratis y VIP con Telegram vinculado', canales: ['telegram'], apagable: true,
    variables: ['municipio', 'estado', 'hora'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje de Telegram', tipo: 'telegram', defecto: '✅ Seguimos vigilando {municipio}, {estado}\nEstado actual: Cerrado\nÚltima revisión: {hora} hrs\n\nTe avisaremos en cuanto abra.' }
    ],
    params: [{ clave: 'cada_horas', etiqueta: 'Enviar cada', unidad: 'horas', min: 1, max: 72, defecto: 24 }]
  },
  {
    clave: 'cuenta_regresiva', num: 4, etapa: 'monitoreo', icono: '⏳',
    titulo: 'Cuenta regresiva',
    cuando: 'Diario a las 9:00 (CDMX) mientras la fecha estimada de apertura esté en el futuro.',
    quien: 'Todos los activos (a Gratis se agrega la invitación a VIP)', canales: ['telegram', 'correo'], apagable: true,
    variables: ['faltan_dias', 'municipio', 'estado', 'precio', 'link_vip'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje (Telegram y cuerpo del correo)', tipo: 'telegram', defecto: '⏳ Faltan {faltan_dias} para que abra el registro de Jóvenes Construyendo el Futuro en {municipio}, {estado}.\n\n📝 Haz tu preregistro en la plataforma oficial en cuanto esté disponible.\n📄 Ten a la mano el día de la apertura: tu INE, tu CURP y un comprobante de domicilio ORIGINAL.\n🤳 También te van a pedir tomarte una selfie ese día — prepárate.' },
      { clave: 'upsell', etiqueta: 'Invitación a VIP (solo a Gratis)', tipo: 'telegram', defecto: 'Actualmente tienes el plan Gratis. Con VIP ({precio}, 14 días) además de Telegram recibes correo y una llamada automática en cuanto abra tu municipio — más posibilidades de enterarte a tiempo. Súbete aquí: {link_vip}' },
      { clave: 'asunto', etiqueta: 'Asunto del correo', tipo: 'asunto', defecto: 'Faltan {faltan_dias} para la apertura — Monitor JCF' }
    ]
  },
  {
    clave: 'apertura', num: 5, etapa: 'apertura', icono: '🟢',
    titulo: '¡Abrió tu municipio!',
    cuando: 'El municipio del cliente pasa de cualquier estado a "Abierto".',
    quien: 'Gratis y VIP de ese municipio (VIP además recibe llamada)', canales: ['telegram', 'correo', 'llamada'], apagable: false,
    variables: ['municipio', 'estado', 'link_soporte'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje de Telegram', tipo: 'telegram', defecto: '🔔🟢 ¡{municipio} ESTÁ ABIERTO AHORA!\n\n📍 {estado}\n\n👉 Entra a la plataforma de Jóvenes Construyendo el Futuro y regístrate — los cupos se llenan rápido.' },
      { clave: 'asunto', etiqueta: 'Asunto del correo', tipo: 'asunto', defecto: '{municipio} está abierto — Monitor JCF' },
      { clave: 'correo', etiqueta: 'Mensaje del correo', tipo: 'correo', defecto: '{estado} — entra a la plataforma oficial de Jóvenes Construyendo el Futuro y regístrate lo antes posible.' },
      { clave: 'extra_vip', etiqueta: 'Línea de soporte al final (solo VIP, también en recordatorios)', tipo: 'telegram', defecto: '💬 ¿Dudas, preguntas o algo no funciona? Escríbenos aquí mismo en este chat, o desde tu panel: {link_soporte}' }
    ]
  },
  {
    clave: 'recordatorio_vip', num: 6, etapa: 'apertura', icono: '🔁',
    titulo: 'Recordatorios reforzados',
    cuando: 'El municipio sigue Abierto después del primer aviso.',
    quien: 'Solo VIP de ese municipio', canales: ['telegram'], apagable: true,
    variables: ['n', 'total', 'municipio', 'estado'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje de Telegram', tipo: 'telegram', defecto: '🔔🟢 Recordatorio ({n}/{total}): {municipio} sigue ABIERTO\n\n📍 {estado}\n\n👉 Si aún no te registras, entra a la plataforma ahora — puede cerrar en cualquier momento.' }
    ],
    params: [
      { clave: 'maximo', etiqueta: 'Recordatorios', unidad: 'en total', min: 1, max: 8, defecto: 4 },
      { clave: 'espaciado_min', etiqueta: 'Uno cada', unidad: 'minutos', min: 5, max: 60, defecto: 15 },
      { clave: 'ventana_min', etiqueta: 'Durante', unidad: 'minutos', min: 15, max: 240, defecto: 60 }
    ]
  },
  {
    clave: 'cambio_estado', num: 7, etapa: 'apertura', icono: '🏁',
    titulo: 'Meta alcanzada / cambio de estado',
    cuando: 'El municipio pasa a cualquier estado que no sea "Abierto" (p. ej. Meta alcanzada).',
    quien: 'Gratis y VIP de ese municipio', canales: ['telegram'], apagable: true,
    variables: ['municipio', 'estado', 'estado_nuevo'],
    campos: [
      { clave: 'texto', etiqueta: 'Mensaje de Telegram', tipo: 'telegram', defecto: 'ℹ️ Actualización de {municipio}, {estado}\n\nEstado actual: {estado_nuevo}\n\nSi ya alcanzó la meta, probablemente el cupo se llenó. Seguimos monitoreando por si hay más cambios.' }
    ]
  },
  {
    clave: 'pago_aprobado', num: 8, etapa: 'vip', icono: '★',
    titulo: 'Pago aprobado — VIP activo',
    cuando: 'Mercado Pago confirma el pago del VIP.',
    quien: 'El cliente que pagó', canales: ['correo'], apagable: false,
    variables: ['nombre', 'municipio', 'estado'],
    campos: [
      { clave: 'asunto_nuevo', etiqueta: 'Asunto (aún sin Telegram)', tipo: 'asunto', defecto: 'Tu monitoreo VIP de JCF ya está activo' },
      { clave: 'intro_nuevo', etiqueta: 'Mensaje (aún sin Telegram)', tipo: 'correo', defecto: '¡Gracias por tu pago! Vamos a vigilar por ti:' },
      { clave: 'asunto_vinculado', etiqueta: 'Asunto (ya tenía Telegram)', tipo: 'asunto', defecto: 'Tu plan VIP de Monitor JCF ya está activo' },
      { clave: 'intro_vinculado', etiqueta: 'Mensaje (ya tenía Telegram)', tipo: 'correo', defecto: '¡Listo! Tu cuenta ya es VIP — no hace falta que hagas nada más en Telegram, ya está vinculado.' }
    ]
  },
  {
    clave: 'vencimiento_vip', num: 9, etapa: 'vip', icono: '⌛',
    titulo: 'Vencimiento VIP', proximamente: true,
    cuando: 'Pasan 14 días desde el pago: la cuenta vuelve a Gratis.',
    quien: 'El cliente cuyo VIP venció', canales: ['telegram', 'correo'], apagable: true,
    variables: [], campos: []
  },
  {
    clave: 'soporte', num: 10, etapa: 'soporte', icono: '💬',
    titulo: 'Soporte por el bot',
    cuando: 'Un cliente le escribe texto libre al bot, o el admin le responde.',
    quien: 'VIP (Gratis recibe la invitación a subir)', canales: ['telegram'], apagable: false,
    variables: ['link_vip'],
    campos: [
      { clave: 'recibido', etiqueta: 'Respuesta automática a un VIP', tipo: 'telegram', defecto: '✅ Recibimos tu mensaje. Te respondemos por aquí mismo en cuanto podamos.' },
      { clave: 'solo_vip', etiqueta: 'Respuesta a un cliente Gratis', tipo: 'telegram', defecto: 'El soporte directo por este chat es exclusivo del plan VIP. Si quieres subir a VIP: {link_vip}' },
      { clave: 'prefijo_respuesta', etiqueta: 'Encabezado de tus respuestas', tipo: 'telegram', defecto: '💬 Respuesta de soporte Monitor JCF:' }
    ]
  },
  {
    clave: 'bot_avisos', num: 11, etapa: 'soporte', icono: '🤖',
    titulo: 'Mensajes del bot',
    cuando: 'Alguien usa el bot sin estar vinculado, con un link inválido o con la cuenta dada de baja.',
    quien: 'Quien le escribe al bot', canales: ['telegram'], apagable: false,
    variables: [],
    campos: [
      { clave: 'sin_codigo', etiqueta: '/start sin código', tipo: 'telegram', defecto: 'Para vincular tu monitoreo, abre el link que te llegó por correo al registrarte (revisa también spam), o el botón de Telegram en tu panel.' },
      { clave: 'link_invalido', etiqueta: 'Link no válido', tipo: 'telegram', defecto: 'No encontramos un registro con ese link. Si el problema sigue, escríbenos.' },
      { clave: 'inactiva', etiqueta: 'Cuenta dada de baja', tipo: 'telegram', defecto: 'Tu suscripción ya no está activa. Si crees que es un error, contáctanos.' }
    ]
  },
  {
    clave: 'recuperar_password', num: 12, etapa: 'soporte', icono: '🔑',
    titulo: 'Recuperar contraseña',
    cuando: 'El cliente pide recuperar su contraseña en "Entrar".',
    quien: 'El cliente que lo pidió', canales: ['correo'], apagable: false,
    variables: [],
    campos: [
      { clave: 'asunto', etiqueta: 'Asunto del correo', tipo: 'asunto', defecto: 'Recupera tu acceso a Monitor JCF' },
      { clave: 'parrafo', etiqueta: 'Mensaje del correo', tipo: 'correo', defecto: 'Pediste recuperar tu contraseña. Este enlace es válido por 1 hora:' }
    ]
  }
];

export const VARIABLES = V;
export const POR_CLAVE = Object.fromEntries(ESTACIONES.map(e => [e.clave, e]));
export const MAX_TEXTO = 3500; // Telegram corta a 4096; dejamos margen para lo que se agrega

// Reemplaza {variables}; las desconocidas se dejan tal cual para que se note.
export function render(texto, vars = {}) {
  return String(texto ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// Texto de correo -> HTML seguro (escapado, saltos de línea a <br>).
export function textoAHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

async function leerOverrides() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/flujo_config?select=clave,activo,textos,params,updated_at`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!res.ok) return {}; // p. ej. sql/009 aún sin correr: todo de fábrica
    const filas = await res.json();
    return Object.fromEntries(filas.map(f => [f.clave, f]));
  } catch { return {}; }
}

// Configuración efectiva (fábrica + cambios del admin). Una lectura por
// invocación de función basta: los crons y webhooks son de corta vida.
export async function cargarFlujo() {
  const ov = await leerOverrides();
  const est = (clave) => POR_CLAVE[clave];
  return {
    overrides: ov,
    activo(clave) {
      const e = est(clave);
      if (!e || !e.apagable) return true;
      return ov[clave]?.activo !== false;
    },
    texto(clave, campo, vars) {
      const def = est(clave)?.campos.find(c => c.clave === campo)?.defecto ?? '';
      const guardado = ov[clave]?.textos?.[campo];
      return render(typeof guardado === 'string' && guardado.trim() ? guardado : def, vars);
    },
    param(clave, p) {
      const d = est(clave)?.params?.find(x => x.clave === p);
      if (!d) return undefined;
      const v = Number(ov[clave]?.params?.[p]);
      return Number.isFinite(v) && v >= d.min && v <= d.max ? v : d.defecto;
    }
  };
}
