# Mensajes de Monitor JCF — edítalo y dime "lee este documento y actualiza el proyecto"

Este archivo lista **cada mensaje** que el sistema manda por Telegram o
correo, y en qué archivo/función vive. Edita el texto que quieras
cambiar directamente aquí (respeta las llaves `{así}` — son los datos
que se rellenan solos) y dime que lo lea; yo aplico los cambios al
código.

---

## 1. Registro — Plan Gratis

**Cuándo:** al completar el registro gratuito, si NO tenía Telegram
vinculado de antes.
**Dónde:** `netlify/functions/lib/email.mjs` → `plantillaBienvenida({plan:'free'})`
**Canal:** Correo (Resend)

> **Asunto:** ✅ Tu monitoreo gratuito de JCF ya está activo
>
> 🔔 Monitor JCF
>
> ¡Tu prueba gratuita ya quedó activa! Vamos a vigilar por ti:
>
> Municipio: **{municipio}**
> Estado: {estado}
> Plan: Gratis — revisión periódica por Telegram
>
> **Un último paso:** vincula tu Telegram para recibir la alerta.
> [Vincular mi Telegram] → {telegramLink}
>
> Entra a tu panel cuando quieras en tu cuenta con este correo y la
> contraseña que elegiste.

---

## 2. Registro/renovación — Plan VIP (correo aprobado)

**Cuándo:** al aprobarse el pago VIP, si NO tenía Telegram vinculado de antes.
**Dónde:** `netlify/functions/lib/email.mjs` → `plantillaBienvenida({plan:'vip'})`
**Canal:** Correo (Resend)

> **Asunto:** ✅ Tu monitoreo VIP de JCF ya está activo
>
> 🔔 Monitor JCF
>
> ¡Gracias por tu pago! Vamos a vigilar por ti:
>
> Municipio: **{municipio}**
> Estado: {estado}
> Plan: ★ VIP — revisión frecuente + correo y llamada, activo 14 días
>
> **Un último paso:** vincula tu Telegram para recibir la alerta.
> [Vincular mi Telegram] → {telegramLink}

---

## 3. Escalar a VIP (Telegram ya vinculado desde Gratis)

**Cuándo:** al escalar de Gratis a VIP (o renovar), si YA tenía Telegram vinculado.
**Dónde:** `netlify/functions/lib/email.mjs` → `plantillaUpgradeVinculado()`
**Canal:** Correo (Resend)

> **Asunto:** ✅ Tu plan VIP de Monitor JCF ya está activo
>
> 🔔 Monitor JCF
>
> ¡Listo! Tu cuenta ya es **VIP** — no hace falta que hagas nada más en
> Telegram, ya está vinculado.
>
> Municipio: **{municipio}**
> Estado: {estado}
> Plan: ★ VIP — revisión frecuente + correo y llamada, activo 14 días

---

## 4. Reactivar cuenta Gratis (Telegram ya vinculado)

**Cuándo:** al re-registrarse en Gratis con un correo que ya tenía cuenta archivada, con Telegram ya vinculado.
**Dónde:** `netlify/functions/register-free.mjs` (plantilla en línea)
**Canal:** Correo (Resend)

> **Asunto:** ✅ Tu monitoreo gratuito de JCF ya está activo
>
> 🔔 Monitor JCF
>
> ¡Listo! Tu cuenta quedó activa de nuevo — tu Telegram ya está
> vinculado, no hace falta hacer nada más.
>
> Municipio: **{municipio}**
> Estado: {estado}

---

## 5. Recuperar contraseña

**Cuándo:** el usuario pide "olvidé mi contraseña".
**Dónde:** `netlify/functions/customer-auth.mjs` (plantilla en línea, acción `olvide`)
**Canal:** Correo (Resend) — válido 1 hora

> **Asunto:** Recupera tu acceso a Monitor JCF
>
> Monitor JCF
>
> Pediste recuperar tu contraseña. Este enlace es válido por 1 hora:
> [Elegir nueva contraseña] → {SITE_URL}/?reset={token}
>
> Si no fuiste tú, ignora este correo.

---

## 6. Apertura de municipio — correo (Gratis y VIP)

**Cuándo:** cuando su municipio pasa a "Abierto" (en la revisión de SU plan). No se manda en "Meta alcanzada".
**Dónde:** `netlify/functions/check-jcf-nacional.mjs` (plantilla en línea)
**Canal:** Correo (Resend) — respeta `email_enabled`

> **Asunto:** 🟢 {municipio} está abierto — Monitor JCF
>
> ¡{municipio} está abierto!
>
> {estado} — entra a la plataforma oficial de Jóvenes Construyendo el
> Futuro y regístrate lo antes posible.
> [Ir a la plataforma oficial] → https://jovenesconstruyendoelfuturo.stps.gob.mx/

---

## 7. Recordatorio de cuenta regresiva (nuevo — antes de la apertura)

**Cuándo:** una vez al día, mientras `fecha_estimada_apertura` esté en el futuro. Para Gratis y VIP.
**Dónde:** `netlify/functions/recordatorio-apertura.mjs`
**Canal:** Telegram + Correo (respeta `telegram_enabled` / `email_enabled`)

**Telegram:**

> ⏳ Faltan {dias} días para que abra el registro de Jóvenes
> Construyendo el Futuro en {municipio}, {estado}.
>
> 📝 Haz tu preregistro en la plataforma oficial en cuanto esté disponible.
> 📄 Ten a la mano el día de la apertura: tu INE, tu CURP y un
> comprobante de domicilio ORIGINAL.
> 🤳 También te van a pedir tomarte una selfie ese día — prepárate.
>
> _(Solo si es plan Gratis, se agrega:)_
> Actualmente tienes el plan Gratis. Con VIP ($100 MXN, 14 días) además
> de Telegram recibes correo y una llamada automática en cuanto abra tu
> municipio — más posibilidades de enterarte a tiempo. Súbete aquí:
> {SITE_URL}
>
> Si no quieres recibir más recordatorios como este, date de baja aquí:
> {bajaLink}

**Correo:** mismo contenido, con el checklist de documentos como lista,
y el aviso de "date de baja aquí" al final en letra pequeña.

---

## 8. Vincular Telegram — confirmación

**Cuándo:** al hacer clic en el link de Telegram y mandar `/start {token}`.
**Dónde:** `netlify/functions/telegram-webhook.mjs`
**Canal:** Telegram

> ✅ ¡Listo! Quedaste vinculado.
>
> Estamos monitoreando: {municipio}, {estado}
>
> Te avisaremos por aquí en cuanto abra.

**Otros mensajes del bot** (mismo archivo):
- Si el token no existe: *"No encontramos un registro con ese link. Si el problema sigue, escríbenos."*
- Si la cuenta ya no está activa: *"Tu suscripción ya no está activa. Si crees que es un error, contáctanos."*
- Si escriben `/start` sin token: *"Para vincular tu monitoreo, abre el link que te llegó por correo después de tu pago."*

---

## 9. Apertura de municipio — Telegram (Gratis y VIP)

**Dónde:** `netlify/functions/check-jcf-nacional.mjs` → `textoTelegram()`
**Canal:** Telegram — respeta `telegram_enabled`

**Si abrió:**
> 🔔🟢 ¡{municipio} ESTÁ ABIERTO AHORA!
>
> 📍 {estado}
>
> 👉 Entra a la plataforma de Jóvenes Construyendo el Futuro y
> regístrate — los cupos se llenan rápido.

**Si llegó a "Meta alcanzada":**
> ℹ️ Actualización de {municipio}, {estado}
>
> Estado actual: {estadoNuevo}
>
> Si ya alcanzó la meta, probablemente el cupo se llenó. Seguimos
> monitoreando por si hay más cambios.

---

## 10. Recordatorio reforzado (solo VIP, hasta 4 veces en la 1ª hora)

**Dónde:** `netlify/functions/check-jcf-nacional.mjs`
**Canal:** Telegram — exclusivo VIP, cada ~15 min mientras siga "Abierto"

> 🔔🟢 Recordatorio ({n}/4): {municipio} sigue ABIERTO
>
> 📍 {estado}
>
> 👉 Si aún no te registras, entra a la plataforma ahora — puede cerrar
> en cualquier momento.

---

## 11. "Seguimos vigilando" (heartbeat, cada hora, si sigue Cerrado)

**Dónde:** `netlify/functions/heartbeat-jcf.mjs`
**Canal:** Telegram — Gratis y VIP con Telegram vinculado

> ✅ Seguimos vigilando {municipio}, {estado}
> Estado actual: Cerrado
> Última revisión: {hora} hrs
>
> Te avisaremos en cuanto abra.

---

## 12. Guion de la llamada Talkyria (solo VIP)

**Dónde:** `scripts/crear-agente-talkyria.mjs` → `PROMPT_AVISO` (esto configura al agente, no es un mensaje que se mande por API en cada llamada — hay que volver a correr el script si lo cambias)
**Canal:** Llamada de voz — exclusivo VIP con teléfono activado

> "Aviso automático de Monitor JCF. El registro para {municipio},
> {estado} ya está abierto. Entra ahora a la plataforma oficial para
> intentar registrarte. Muchas gracias por su atención. Este es un
> servicio de avisos automatizados, puede colgar ahora."

---

## 13. Página de confirmación al darse de baja

**Cuándo:** al hacer clic en el link de baja de cualquier mensaje.
**Dónde:** `netlify/functions/baja.mjs`
**Canal:** Página web simple (no es correo ni Telegram)

> 🔔 Monitor JCF
>
> Ya diste de baja tu cuenta — no volverás a recibir mensajes de
> Monitor JCF. Si cambias de opinión, puedes registrarte de nuevo
> cuando quieras.

---

## Cómo pedirme un cambio

1. Edita el texto que quieras arriba (o dime aquí en el chat qué cambiar).
2. Dime algo como: **"lee MENSAJES-MONITOR-JCF.md y actualiza el proyecto."**
3. Yo aplico cada cambio al archivo de código correspondiente (columna
   "Dónde" de cada mensaje) y te confirmo qué quedó listo.
