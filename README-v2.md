# Monitor JCF — v2 comercial completo

Esto es tu proyecto original (`monitor-jcf-comercial`) con todo lo del
panel de diseño rescatado hecho real: plan Gratis/VIP, login de
clientes, portal de autoservicio con el mapa en vivo, programa de
referidos, llamadas Talkyria, y un panel de administrador rediseñado
conectado a datos reales.

**No pude probar nada de esto en vivo.** El entorno donde lo escribí no
tiene salida de red hacia Supabase, Netlify, Telegram, MercadoPago ni
Talkyria — solo pude escribir el código siguiendo exactamente los
mismos patrones que ya usa tu sistema en producción (que sí probaste).
Antes de confiar en esto para cobrar de verdad, corre los pasos de
"Cómo desplegar y probar" de abajo, o pásaselo a Claude Code para que
lo despliegue y pruebe con tus credenciales reales.

## 1. Ejecuta las migraciones SQL, en orden

Abre Supabase → SQL Editor → corre primero **`sql/002_comercial_v2.sql`**
y luego **`sql/003_talkyria_real.sql`**. Ambas son aditivas: agregan
columnas y tablas nuevas, no tocan lo que ya tienes. Tus suscriptores
actuales quedan marcados `plan='vip'` automáticamente (ya pagaron $100,
es justo).

## 2. Variables de entorno nuevas en Netlify

Todas las que ya tenías siguen igual. Agrega:

| Variable | Para qué sirve |
|---|---|
| `TALKYRIA_API_KEY` | Tu API key de Talkyria — usa `tk_test_...` para probar sin gastar saldo ni hacer llamadas reales, y cámbiala a `tk_live_...` cuando ya confirmes que todo funciona |
| `TALKYRIA_API_URL` | Opcional — si no la pones, usa `https://api.talkyria.com/api/v1` por default |
| `TALKYRIA_AGENT_ID` | El id que te da `scripts/crear-agente-talkyria.mjs` al correrlo (paso 2.1) |
| `TALKYRIA_WEBHOOK_SECRET` | El secret que te dé Talkyria al registrar el webhook (paso 2.2) |
| `GOOGLE_CLIENT_ID` | De tu proyecto en Google Cloud Console (paso 2.3) |
| `GOOGLE_CLIENT_SECRET` | Idem |

Al crear tu API key en Talkyria (Integraciones → API → Crear clave),
actívale estos permisos: `calls:trigger`, `calls:read`, `agents:write`,
`agents:read`, `webhooks:write`.

### 2.1 Crea el agente (aviso corto, no conversacional)

Por default los agentes de Talkyria vienen conversacionales — por eso
hay que crear uno configurado desde el inicio como un aviso que se lee
una vez y cuelga, en vez de intentar forzarlo con parámetros sueltos en
cada llamada (esa era la idea equivocada de la versión anterior).

En tu computadora, con Node 18+:

```bash
TALKYRIA_API_KEY=tk_test_TU_CLAVE node scripts/crear-agente-talkyria.mjs
```

Esto crea el agente ya con el guion correcto (el mismo texto que
armamos juntos, con el cierre "puede colgar ahora") y con los límites
de duración/silencio configurados para que no se alargue. Al final te
imprime el `agentId` — cópialo a `TALKYRIA_AGENT_ID` en Netlify.

Prueba primero con una clave `tk_test_...` (no hace llamadas reales,
solo simula) y cuando quieras el agente de verdad, vuelve a correr el
script con tu clave `tk_live_...` — te da un `agentId` distinto, ese es
el que usas en producción.

### 2.2 Registra el webhook en el panel de Talkyria

En la pantalla que me mandaste ("Webhook de notificaciones"):

1. **URL del webhook**: `https://<tu-sitio>.netlify.app/.netlify/functions/talkyria-webhook`
2. **Secret**: déjalo vacío para que Talkyria lo genere (el secret solo
   se muestra una vez) — cópialo a `TALKYRIA_WEBHOOK_SECRET` en Netlify.
   Si no coinciden, el webhook llega pero se descarta por firma
   inválida (no se actualiza nada, tampoco truena nada).
3. Déjalo suscrito al default (`call.outcome_final`, todos los
   resultados) — ya están los 7 eventos mapeados en `lib/talkyria.mjs`.

### 2.3 Da de alta "Continuar con Google"

A diferencia de Talkyria, el protocolo de Google (OAuth 2.0) sí está
público y documentado, así que esto no es una adivinanza — está escrito
contra su especificación real. Solo falta que crees las credenciales:

1. Entra a [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   crea un proyecto (o usa uno que ya tengas) y crea credenciales tipo
   **"ID de cliente de OAuth"**, aplicación tipo **Aplicación web**.
2. En **"Orígenes de JavaScript autorizados"** pon la URL de tu sitio:
   `https://<tu-sitio>.netlify.app`
3. En **"URI de redirección autorizados"** pon exactamente:
   `https://<tu-sitio>.netlify.app/.netlify/functions/google-auth?action=callback`
4. Copia el **Client ID** y el **Client secret** a `GOOGLE_CLIENT_ID` y
   `GOOGLE_CLIENT_SECRET` en Netlify.

El botón de Google solo queda en el **login** de la portada (`/`), igual
que en el mockup — sirve para entrar a una cuenta que ya existe (dada
de alta por correo o por un pago VIP), buscándola por el correo que
confirme Google. Si el correo de Google no tiene cuenta todavía, manda
al mismo formulario con un aviso para registrarse primero.

## 3. La arquitectura cambió: un solo `/` en vez de landing + cuenta separadas

A partir de esta versión, **ya no existe `index.html` como landing
aparte**. Todo — login, activar tu alerta (Gratis o VIP, con el
checkout de MercadoPago si eliges VIP) y el panel de cuenta completo —
vive en un solo archivo: `public/index.html`, servido en `/`. Y tanto
ese archivo como `public/admin.html` dejaron de ser mi rediseño
simplificado: ahora usan el **diseño exacto que rescataste de ChatGPT**
(la misma maqueta, colores, tarjetas y componentes), ya con todo
conectado a datos reales en vez de datos de ejemplo.

Si algo en tu correo, Talkyria o Google apuntaba a `/cuenta.html`, ya
no aplica — todo quedó actualizado a `/`.

## 4. Qué quedó 100% real (mismo patrón que tu código actual)

- **Plan Gratis / VIP**: dentro del mismo formulario de "Activa tu
  alerta" en `/` — Gratis se da de alta directo (`register-free.mjs`),
  VIP pasa por MercadoPago como antes. Desde el panel, "Subir a VIP"
  regresa a ese mismo formulario con el plan VIP preseleccionado, no a
  una página aparte.
- **Login de clientes** (correo + contraseña, como pediste): sesiones
  reales en la tabla `sesiones`, contraseñas con `scrypt` (nada de
  texto plano, ni siquiera temporalmente). También se agregó
  **"Continuar con Google"** tal como en el mockup.
- **Portal de cuenta**: mapa nacional real (el mismo SVG y
  `/get-catalogo` de siempre, no uno nuevo inventado), cambiar
  municipio, activar/desactivar canales, ver su código de referido,
  encuesta VIP con descuento de continuidad (50%/70%), cambiar
  contraseña, recuperar contraseña por correo.
- **Panel admin `/admin.html`**: Resumen, Monitoreos, Usuarios,
  Alertas, Llamadas, Pagos y Referidos leen datos reales de Supabase —
  nada de cifras de ejemplo. Ciclos y fechas usa tus columnas de
  `configuracion` (ampliadas) y calcula la fase actual en vez de
  tenerla fija. El interruptor "Registro abierto a nuevos usuarios" ya
  bloquea altas de verdad si lo apagas (antes solo se guardaba, no
  hacía nada).
- **Referidos**: código único de 6 caracteres por usuario, enlace
  corto `/.netlify/functions/track-ref?code=X` que cuenta clics de
  verdad y redirige con `?ref=` para que el registro capture quién
  refirió.
- **Correo al abrir tu municipio (VIP)**: se agregó a
  `check-jcf-nacional.mjs`, mismo remitente y estilo que ya usas.

## 5. Qué se adaptó del diseño rescatado (y por qué)

El mockup de ChatGPT tenía varias cosas puramente decorativas que no
tenía sentido fabricar sin datos reales detrás — se quitaron o se
reemplazaron por algo honesto en vez de dejarlas fingiendo que hacen
algo:

- El **saldo de Talkyria** ("$18.45 USD, 123 minutos") no se muestra —
  no hay forma de consultarlo sin saber su API. Revisa tu saldo
  directo en su panel.
- Botones sin backend real detrás ("＋ Nuevo monitoreo", "＋ Nuevo
  usuario", "＋ Crear campaña", "Guardar reglas" en reglas que son fijas
  en el código) se quitaron en vez de dejarlos mostrando un
  "guardado correctamente" falso.
- Las **5 fases del ciclo** se calculan de verdad a partir de tus
  fechas reales en vez de ser texto fijo.
- Se quitó la pantalla "Documento del proyecto" (era solo texto
  estático, no una función) y el plan-switch de demostración
  ("Cuenta Gratis / Cuenta VIP") del panel de cliente — ahora muestra
  tu plan real, no un botón para fingir que lo cambias.

## 6. Cómo quedó Talkyria por dentro (ya con su doc real)

Con la documentación que mandaste (`https://app.talkyria.com/docs/api`)
esto dejó de ser una adivinanza. Lo importante que cambió respecto a la
primera versión:

- **No hay un campo "di este texto"** en la petición de llamada —
  Talkyria es un motor de IA conversacional de verdad, y lo que dice lo
  define el **prompt del agente** (configurado una vez), no cada
  llamada suelta. Por eso ahora existe `scripts/crear-agente-talkyria.mjs`
  (paso 2.1): crea ese agente ya con el guion correcto y los límites
  de duración/silencio, en vez de intentar forzarlo con parámetros
  adivinados como hacía la versión anterior.
- Por llamada, `lib/talkyria.mjs` solo manda `customVariables`
  (`cv_municipio`, `cv_estado`) para que el agente los mencione, y el
  `agentId` de ese agente ya configurado.
- `externalId` es la clave de idempotencia de Talkyria — reusamos tu
  misma clave anti-duplicado (`evento`) ahí, así que hay protección
  doble contra llamadas repetidas (la tuya en Supabase y la de ellos).
- Las llamadas son asíncronas: disparar solo confirma que la aceptaron;
  el resultado real (`confirmada`, `no_contesto`, `buzon`, etc., más un
  resumen de lo que pasó) llega después por el webhook, ya con firma
  verificada.

Una sola cosa sigue siendo un supuesto razonable en vez de un hecho
100% confirmado: su documentación no publica el "sobre" completo del
webhook (solo el objeto `call` de adentro), así que no sé con certeza
si el pedido/`externalId` viaja junto a `call` para emparejar la fila
correcta. `talkyria-webhook.mjs` ya intenta varias rutas razonables
para encontrarla, pero si alguna vez ves en los logs de Netlify
"no encontró fila que actualizar", ese es el punto exacto a revisar —
mándame el payload completo que llegó (sin el número de teléfono si
prefieres) y lo ajusto al toque.

## 7. Cómo desplegar y probar

1. Corre las migraciones SQL (paso 1).
2. Agrega las variables de entorno nuevas y configura el webhook en
   Talkyria (paso 2).
3. Sube esta carpeta a tu repo de git (reemplaza los archivos
   existentes) y haz push — Netlify despliega solo.
4. Prueba en este orden: registro Gratis → revisa que llegue el
   correo y el bot de Telegram → entra a `/` con esa cuenta
   → cambia municipio y canales → prueba "Olvidé mi contraseña".
5. Prueba un pago VIP de verdad (o en modo sandbox de MercadoPago si
   tienes credenciales de prueba) → confirma que el correo/Telegram
   lleguen y que aparezca en Pagos y Usuarios del admin.
6. Cuando confirmes el formato real de Talkyria, prueba una llamada
   forzando un cambio de estado en `check-jcf-nacional` (o pídele a
   Claude Code que simule el evento).

Si prefieres que alguien más termine y verifique todo esto con tus
credenciales reales en vez de hacerlo tú a mano, esto es exactamente
lo que le pasarías a **Claude Code**: ya tiene todo el código listo,
solo le falta correr contra tus servicios de verdad.

## 8. Nota sobre la carpeta `preview/`

Los dos archivos ahí (`admin-preview.html`, `cuenta-preview.html`) son
de la versión anterior, con mi rediseño simplificado — no reflejan el
diseño original que se usa ahora en `public/`. No se despliegan (igual
que antes, Netlify solo publica `/public`), pero si los abres directo
en el navegador vas a ver la versión vieja. Bórralos cuando quieras, o
dime si quieres que los actualice al diseño nuevo.
