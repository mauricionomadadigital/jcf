// public/pixel.js
// Meta Pixel de Monitor JCF (ID 1456607546341278), compartido por todas
// las páginas públicas (el panel admin NO lo carga). Solo manda eventos y
// datos de la compra — nunca correo, nombre ni teléfono del cliente.
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
// y el de Google llega con #nuevo=1. Se dispara una sola vez.
window.jcfPixelRegistroNuevo = function () {
  var nuevo = false;
  try {
    nuevo = new URLSearchParams(location.hash.replace(/^#/, '')).get('nuevo') === '1' || !!sessionStorage.getItem('jcf_registro_nuevo');
    sessionStorage.removeItem('jcf_registro_nuevo');
  } catch (e) {}
  if (nuevo) window.jcfPixel('CompleteRegistration', { content_name: 'Cuenta gratis', status: true, value: 0, currency: 'MXN' });
};
