// public/pixel.js
// Meta Pixel de Monitor JCF (ID 1456607546341278), compartido por todas
// las páginas públicas (el panel admin NO lo carga). En el panel y el
// checkout se le pasan el correo y el teléfono de la cuenta (coincidencias
// avanzadas): el propio pixel los cifra con SHA-256 antes de enviarlos, y
// nunca se manda el nombre. La compra también se reporta desde el
// servidor: lib/meta-capi.mjs.
//
// Eventos del embudo:
//   PageView             todas las páginas públicas (aquí mismo)
//   ViewContent          página de registro (index.html)
//   CompleteRegistration primera llegada al panel/checkout tras crear cuenta
//   InitiateCheckout     abre el checkout VIP
//   AddPaymentInfo       clic en "Pagar con Mercado Pago"
//   Purchase             regreso de Mercado Pago con pago aprobado
!function (f, b, e, v, n, t, s) {
  if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
  if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
  t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
}(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1456607546341278');
fbq('track', 'PageView');

// Nunca debe romper la página si el pixel está bloqueado (adblock, etc.).
window.jcfPixel = function (evento, datos, opciones) {
  try { fbq('track', evento, datos || {}, opciones || {}); } catch (e) {}
};
// Para eventos que no deben contarse dos veces aunque recargue la página.
window.jcfPixelUnaVez = function (clave, evento, datos, opciones) {
  try {
    if (localStorage.getItem('jcf_px_' + clave)) return;
    localStorage.setItem('jcf_px_' + clave, '1');
  } catch (e) {}
  window.jcfPixel(evento, datos, opciones);
};
// Registro recién terminado: el alta con correo lo marca en sessionStorage
// y el de Google llega con #nuevo=1. Aquí solo se ANOTA (hay que leerlo
// antes de que la página limpie el #); el evento sale en jcfPixelUsuario,
// ya con correo y teléfono, o a los 8 s si la cuenta no llegara a cargar.
var registroPendiente = false;
function dispararRegistro() {
  if (!registroPendiente) return;
  registroPendiente = false;
  window.jcfPixel('CompleteRegistration', { content_name: 'Cuenta gratis', status: true, value: 0, currency: 'MXN' });
}
window.jcfPixelRegistroNuevo = function () {
  try {
    registroPendiente = new URLSearchParams(location.hash.replace(/^#/, '')).get('nuevo') === '1' || !!sessionStorage.getItem('jcf_registro_nuevo');
    sessionStorage.removeItem('jcf_registro_nuevo');
  } catch (e) {}
  if (registroPendiente) setTimeout(dispararRegistro, 8000);
};
// Coincidencias avanzadas: datos de la cuenta ya cargada. Correo en
// minúsculas y teléfono con lada de país, solo dígitos (formato de Meta);
// el pixel los cifra antes de enviarlos.
window.jcfPixelUsuario = function (cuenta) {
  try {
    if (!cuenta) return;
    var datos = { country: 'mx' };
    if (cuenta.email) datos.em = String(cuenta.email).trim().toLowerCase();
    var tel = String(cuenta.phone || '').replace(/\D/g, '');
    if (tel) datos.ph = String(cuenta.telefono_prefijo || '+52').replace(/\D/g, '') + tel;
    fbq('init', '1456607546341278', datos);
  } catch (e) {}
  dispararRegistro();
};
