# DEPLOY.md — Guía de despliegue para Claude Code

Esto **no es un proyecto nuevo**: es la versión 2 de un sistema que ya
está en producción (`monitor-jcf-comercial`, en Netlify + Supabase +
MercadoPago + Telegram + Resend). Lo que hay en este repo se agrega
encima de lo que ya funciona — no reemplaza cuentas ni servicios, solo
código y configuración nueva.

Sigue las secciones en orden. Cada una dice si la puedes ejecutar tú
directo (comandos) o si necesitas que Mauri te dé algo primero (marcado
con 🔑).

---

## 0. Lo que necesitas que Mauri te dé antes de empezar

No puedes inventar ni adivinar nada de esta lista — pídeselo antes de
avanzar en la sección correspondiente:

| Necesitas | Para qué | Dónde ya vive (si ya existe) |
|---|---|---|
| 🔑 Acceso al repo de GitHub (o permiso para crear uno) | Subir este código | — |
| 🔑 `NETLIFY_AUTH_TOKEN` o sesión de `netlify login`, y el **site ID** del sitio ya desplegado | Actualizar el sitio existente | Netlify → el sitio actual |
| 🔑 `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` | Correr las migraciones SQL | Ya están en las variables de entorno de Netlify del sitio actual — pídeselas a Mauri o léelas desde ahí si tienes acceso |
| 🔑 `TALKYRIA_API_KEY` (ya la tiene — formato `tk_live_...` o `tk_test_...`) | Crear el agente y disparar llamadas | — |
| 🔑 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Login con Google | Mauri los crea en Google Cloud Console (paso 6 — requiere su cuenta, no lo puedes hacer por él) |

Las variables que **ya existen** del sistema actual (`MP_ACCESS_TOKEN`,
`RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
`ADMIN_PASSWORD`, `SITE_URL`) siguen igual — no hace falta tocarlas.

---

## 1. GitHub

Si ya existe un repo para este proyecto, solo agrega y sube los
cambios:

```bash
cd monitor-jcf-comercial-v2
git init   # solo si no hay repo todavía
git add .
git commit -m "v2: planes Gratis/VIP, login de clientes, Talkyria, Google, referidos"
git remote add origin <URL_DEL_REPO>   # solo si no está ya configurado
git branch -M main
git push -u origin main
```

Si Netlify ya está conectado a este repo por git, el push del paso
anterior dispara el despliegue solo — puedes saltar al paso 4 después
de correr las migraciones (paso 3).

---

## 2. Supabase — correr las migraciones, en orden

**Nota:** si el proyecto de Supabase está vacío (no es el mismo que ya
usa el sistema en producción), corre primero `sql/001_esquema_base.sql`
— crea las tablas base (`suscriptores`, `configuracion`,
`historial_cambios`) que el sistema original creó a mano. Si ya tienes
esas tablas, sáltatelo.

Con la CLI de Supabase (si el proyecto ya está vinculado):

```bash
supabase db push --db-url "postgresql://postgres:<PASSWORD>@<HOST>:5432/postgres"
```

O, más simple y sin necesitar la contraseña de la base de datos —
copia y pega el contenido de cada archivo en **Supabase → SQL Editor**
y ejecútalos uno por uno, en este orden:

1. `sql/002_comercial_v2.sql`
2. `sql/003_talkyria_real.sql`
3. `sql/004_frecuencias_bajas_fallos.sql` — frecuencias configurables por
   plan, baja/reactivación de cuentas, purga a los 3 periodos inactivo,
   bloqueo de login y bitácora de fallos.

Todas son aditivas (agregan columnas y tablas nuevas con
`if not exists`) — no borran ni tocan datos existentes. Es seguro
correrlas más de una vez por accidente.

**Verifica** antes de seguir:

```sql
select column_name from information_schema.columns where table_name = 'suscriptores' and column_name = 'plan';
select column_name from information_schema.columns where table_name = 'llamadas' and column_name = 'call_id';
```

Ambas deben regresar una fila.

---

## 3. Crear el agente de Talkyria

Esto crea el agente configurado como aviso-corto-y-cuelga (no
conversacional) por API, usando el prompt exacto que ya se armó con
Mauri:

```bash
TALKYRIA_API_KEY=tk_test_LA_CLAVE_DE_MAURI node scripts/crear-agente-talkyria.mjs
```

Usa primero una clave `tk_test_...` para probar sin gastar saldo ni
hacer llamadas reales. El script imprime un `agentId` al final —
**guárdalo**, lo necesitas en el paso 4. Cuando todo esté verificado
en producción, vuelve a correr el script con la clave `tk_live_...`
real de Mauri para crear la versión de producción (te da un
`agentId` distinto — ese es el que va en Netlify al final).

---

## 4. Netlify — variables de entorno y despliegue

Variables **nuevas** que hay que agregar (mantén las que ya existían):

```bash
netlify env:set TALKYRIA_API_KEY "tk_live_xxx"
netlify env:set TALKYRIA_AGENT_ID "<el id del paso 3>"
netlify env:set TALKYRIA_API_URL "https://api.talkyria.com/api/v1"   # opcional, es el default
netlify env:set GOOGLE_CLIENT_ID "<de Google Cloud Console, paso 6>"
netlify env:set GOOGLE_CLIENT_SECRET "<de Google Cloud Console, paso 6>"
# TALKYRIA_WEBHOOK_SECRET se agrega en el paso 5, después de crear el webhook
```

O directo en el dashboard: **Netlify → Site configuration → Environment
variables**.

Despliega:

```bash
netlify deploy --prod
```

(o simplemente haz `git push` si el sitio ya está conectado por git a
este repo — Netlify despliega solo).

**Verifica** que el sitio cargue:

```bash
curl -sI https://<el-sitio>.netlify.app/ | head -1        # 200
curl -sI https://<el-sitio>.netlify.app/admin.html | head -1   # 200
curl -s https://<el-sitio>.netlify.app/.netlify/functions/get-catalogo | head -c 200
```

---

## 5. Talkyria — registrar el webhook (esto lo hace Mauri, es su panel)

Este paso requiere entrar al dashboard de Talkyria con la cuenta de
Mauri — no es algo que puedas hacer por API. Pídele que:

1. Vaya a **Integraciones → API → Webhooks**.
2. **URL del webhook**: `https://<el-sitio>.netlify.app/.netlify/functions/talkyria-webhook`
3. **Secret**: lo deja vacío para que Talkyria lo genere, y te lo pasa.
4. Le da a "Guardar webhook".

Con el secret que te dé:

```bash
netlify env:set TALKYRIA_WEBHOOK_SECRET "<el secret que generó Talkyria>"
netlify deploy --prod   # o espera al siguiente push, no hace falta redeploy inmediato para env vars
```

---

## 6. Google OAuth (esto también lo hace Mauri, requiere su cuenta de Google)

Pídele que:

1. Entre a [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Cree credenciales tipo **"ID de cliente de OAuth"**, aplicación
   **Aplicación web**.
3. En **Orígenes de JavaScript autorizados**: `https://<el-sitio>.netlify.app`
4. En **URI de redirección autorizados**, exactamente:
   `https://<el-sitio>.netlify.app/.netlify/functions/google-auth?action=callback`
5. Te pase el **Client ID** y el **Client secret**.

Luego tú:

```bash
netlify env:set GOOGLE_CLIENT_ID "<client id>"
netlify env:set GOOGLE_CLIENT_SECRET "<client secret>"
netlify deploy --prod
```

---

## 7. Verificación end-to-end

En este orden, contra el sitio ya desplegado:

1. **Registro Gratis**: entra a `/`, elige plan Gratis, estado/municipio,
   correo y contraseña reales tuyos → confirma que llega el correo y
   que el bot de Telegram responde al vincularte.
2. **Login**: cierra sesión, vuelve a entrar con ese correo/contraseña
   en `/` → debe mostrar el panel con tu municipio.
3. **Cambiar municipio y canales**: pruébalo, confirma que se guarda
   (recárgalo la página y verifica que persiste).
4. **"Olvidé mi contraseña"**: pide el enlace, confirma que llega el
   correo y que el enlace `/?reset=...` funciona.
5. **Login con Google**: pruébalo con una cuenta de Google cuyo correo
   ya esté registrado.
6. **Admin**: entra a `/admin.html` con `ADMIN_PASSWORD`, confirma que
   Resumen/Usuarios/Monitoreos muestran los datos reales que acabas de
   crear.
7. **Pago VIP**: si tienes credenciales de sandbox de MercadoPago,
   haz un pago de prueba completo → confirma que aparece en Pagos y
   Usuarios del admin, y que llega el correo VIP.
8. **Llamada Talkyria**: con `TALKYRIA_AGENT_ID` de una clave
   `tk_test_...`, fuerza un cambio de estado en `check-jcf-nacional`
   (o espera a una apertura real) para un suscriptor VIP con llamada
   activada → revisa en `/admin.html` → Llamadas que aparezca el
   intento, y en los logs de Netlify (`netlify functions:log
   check-jcf-nacional`) que no haya errores.
9. **Webhook de Talkyria**: confirma en `netlify functions:log
   talkyria-webhook` que llegan los eventos y que actualizan la fila
   en la tabla `llamadas` (revisa en Supabase).
10. **Referidos**: comparte tu enlace (`/.netlify/functions/track-ref?code=TUCODIGO`),
    ábrelo en otra pestaña/incógnito, regístrate con otra cuenta →
    confirma que sube el contador de clics y registros en tu panel y
    en el admin.

Si algo de esto falla, revisa primero `README-v2.md` — ahí está el
razonamiento de cada pieza y qué es un supuesto razonable vs. un hecho
100% confirmado (sobre todo la sección de Talkyria).
