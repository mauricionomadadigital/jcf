// netlify/functions/flujo-disparo-background.mjs
// "Disparar ahora → a todos" de Admin > Flujo. Background Function (sufijo
// -background): Netlify responde 202 al instante y esto sigue hasta 15 min.
// El avance queda en la tabla flujo_disparos, que el admin consulta.

import { dispararTodos } from './lib/flujo-disparo.mjs';
import { registrarFallo } from './lib/fallos.mjs';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async (req) => {
  if (req.method !== 'POST') return;
  if (!ADMIN_PASSWORD || req.headers.get('x-admin-password') !== ADMIN_PASSWORD) return;
  let clave;
  try { clave = (await req.json()).clave; } catch { return; }
  try {
    await dispararTodos(clave);
  } catch (err) {
    await registrarFallo({ tipo: 'flujo', origen: 'flujo-disparo-background', detalle: `${clave}: ${err.message}` });
  }
};
