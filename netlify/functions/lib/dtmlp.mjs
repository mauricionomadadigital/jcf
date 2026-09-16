// lib/dtmlp.mjs
// Mismo parser que ya probaste en monitor-jcf-netlify (check-jcf), generalizado
// para servir TODOS los estados y municipios, no solo Guanajuato.

import { registrarFallo } from './fallos.mjs';

export const DTMLP_URL = 'https://jovenesconstruyendoelfuturo.stps.gob.mx/focalizacion/dtmlp.js';

function extraerVariable(scriptText, nombre) {
  const regex = new RegExp('var\\s+' + nombre + '\\s*=\\s*([\\s\\S]*?);\\s*(?:\\r?\\n|var\\s|$)');
  const match = scriptText.match(regex);
  if (!match) return undefined;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return (' + match[1] + ')')();
  } catch (err) {
    throw new Error(`No se pudo interpretar la variable "${nombre}" de dtmlp.js: ${err.message}`);
  }
}

export function parseDtmlp(scriptText) {
  return {
    consulta: extraerVariable(scriptText, 'consulta'),
    inicio: extraerVariable(scriptText, 'inicio'),
    detmun: extraerVariable(scriptText, 'detmun')
  };
}

export function estadoTexto(status) {
  if (status === 1 || status === '1') return 'Abierto';
  if (status === 2 || status === '2') return 'Meta alcanzada';
  return 'Cerrado';
}

export function normalizar(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export async function descargarCatalogo() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let resp;
  try {
    resp = await fetch(DTMLP_URL, { cache: 'no-store', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('El sitio de la STPS tardó demasiado en responder (más de 8 segundos)');
    }
    throw new Error('No se pudo conectar al sitio de la STPS: ' + err.message);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' al descargar dtmlp.js');
  const scriptText = await resp.text();
  const { consulta, inicio, detmun } = parseDtmlp(scriptText);
  if (!inicio || !detmun) {
    throw new Error('No se encontraron las variables esperadas en dtmlp.js (puede que el sitio haya cambiado)');
  }
  return { consulta, inicio, detmun };
}

export async function enviarTelegram(token, chatId, mensaje) {
  if (!token || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: mensaje })
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error('Error Telegram:', data.description);
      await registrarFallo({ tipo: 'telegram', origen: 'enviarTelegram', detalle: `chat_id ${chatId}: ${data.description}` });
    }
    return data.ok;
  } catch (err) {
    console.error('Fallo al llamar a Telegram:', err.message);
    await registrarFallo({ tipo: 'telegram', origen: 'enviarTelegram', detalle: `chat_id ${chatId}: ${err.message}` });
    return false;
  }
}
