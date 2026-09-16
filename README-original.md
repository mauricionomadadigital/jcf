# Monitor JCF — Sistema comercial

## Variables de entorno a configurar en Netlify (Site settings → Environment variables)

| Variable | Para qué sirve |
|---|---|
| `MP_ACCESS_TOKEN` | Token de producción de MercadoPago (misma cuenta que ya usas en BookBuilder) |
| `SITE_URL` | URL final de este proyecto una vez desplegado, ej. `https://monitor-jcf-comercial.netlify.app` |
| `SUPABASE_URL` | URL del proyecto Supabase nuevo que ya creaste |
| `SUPABASE_SERVICE_KEY` | Service role key de ese proyecto Supabase |
| `RESEND_API_KEY` | Misma cuenta de Resend que usas en BookBuilder (o una nueva) |
| `TELEGRAM_BOT_USERNAME` | Usuario del bot "Monitor JCF Xichu" sin @, ej. `Monitorxichu_bot` |
| `TELEGRAM_BOT_TOKEN` | El mismo token que ya usas en el proyecto de Guanajuato — el bot es el mismo |
| `ADMIN_PASSWORD` | Contraseña que tú eliges para entrar a `/admin.html` |

> **Nota temporal:** mientras compras tu dominio propio, `webhook.mjs` manda los correos desde `noreply@bookbuilderai.online` (ya verificado en Resend). En cuanto tengas tu dominio nuevo y lo verifiques en Resend, cambia esa línea en `webhook.mjs` (busca `from: 'Monitor JCF <noreply@...`) y vuelve a desplegar.

## Lo que ya está construido en este paquete

1. `public/index.html` — checkout: elige estado/municipio (en vivo desde el gobierno), paga $100 MXN
2. `public/admin.html` — panel de administrador (protegido por contraseña): configurar periodo global, ver suscriptores, botones de prueba en vivo
3. `netlify/functions/get-catalogo.mjs` — sirve la lista real de estados/municipios para los dropdowns
4. `netlify/functions/create-preference.mjs` — arma el pago en MercadoPago con estado/municipio
5. `netlify/functions/webhook.mjs` — al aprobarse el pago, da de alta al suscriptor en Supabase y le manda el link de Telegram por correo (Resend)
6. `netlify/functions/telegram-webhook.mjs` — recibe el `/start <token>` del bot y vincula el `telegram_chat_id` real del usuario a su suscripción
7. `netlify/functions/check-jcf-nacional.mjs` — cron cada **5 min**: si el periodo global está activo, revisa solo los estados/municipios con suscriptores activos y alerta a cada quien (mensaje distinto si es "Abierto" vs "Meta alcanzada"); cuando un municipio abre, además manda hasta **4 recordatorios espaciados ~15 min** durante la primera hora; también archiva automáticamente (`activo=false`) a todos cuando el periodo ya venció
8. `netlify/functions/heartbeat-jcf.mjs` — cron cada hora: manda "seguimos vigilando" solo a quien sigue Cerrado, para reforzar que el sistema está vivo sin saturar con alertas falsas
9. `netlify/functions/admin-api.mjs` — configuración, lista de suscriptores, pruebas EN VIVO (consultan el estado real del gobierno, no un mensaje genérico)
10. `netlify/functions/lib/dtmlp.mjs` — parser reusado de tu proyecto original (Guanajuato)

## Cómo usar el panel de administrador

1. Entra a `https://<tu-sitio>.netlify.app/admin.html`
2. Escribe la contraseña que pusiste en `ADMIN_PASSWORD`
3. Configura el periodo de monitoreo (ej. 1 al 13 de octubre) y guarda — el cron nacional solo actúa dentro de esas fechas
4. Usa "Probar a todos" o "Probar por estado/municipio" para confirmar que las alertas llegan y ver el estado real de cada quien, antes de que empiece el periodo real
5. Al pasar la fecha de fin del periodo, el sistema archiva solo a todos los suscriptores (sin borrarlos) — no hace falta hacer nada manual

## Paso extra tras desplegar: activar el webhook de Telegram

El bot necesita saber que debe mandarle los mensajes entrantes a esta función nueva (no a la de Guanajuato, que nunca configuró webhook — así que esto no rompe nada de lo que ya tienes). Una sola vez, después de desplegar, visita esta URL en el navegador (sustituye los valores, sin los símbolos `<` `>`):

```
https://api.telegram.org/bot<TU_TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<TU_SITIO>.netlify.app/.netlify/functions/telegram-webhook
```

Debe responder `{"ok":true,"result":true,...}`. A partir de ahí, cada vez que alguien le dé "Start" al bot desde el link de su correo, quedará vinculado automáticamente.

## Política sin reembolsos ni cupones

Se decidió simplificar: si el municipio de un suscriptor no abre durante el periodo pagado, no hay reembolso ni cupón de compensación — el servicio de monitoreo en sí se prestó correctamente durante todo el ciclo, la apertura depende del gobierno. Esto ya está reflejado en el texto del checkout.

## Lo que falta (próximos pasos)

- **Test automático semanal** ("Faltan X semanas para el registro") — todavía no está construido; usaría `fecha_estimada_apertura` de `configuracion` y un cron aparte (ej. `0 10 * * 1`, lunes 10am).
- **Sitio de demo aparte** en otro dominio, con alertas simuladas — pendiente para más adelante, según lo platicado.
- **App propia de MercadoPago** para que el checkout muestre "Monitor JCF" en vez de "Mundo Ebooks Pro".
- **Dominio propio** para que Resend mande los correos desde una dirección de marca en vez de `bookbuilderai.online`.
