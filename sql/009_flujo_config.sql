-- =====================================================================
-- Monitor JCF — Migración v2.7
-- Admin > Flujo: textos, encendido/apagado y parámetros de cada estación
-- del flujo del cliente, editables sin deploy. Cada fila guarda SOLO lo
-- que el admin cambió; lo que no está aquí usa el valor "de fábrica"
-- definido en netlify/functions/lib/flujo.mjs. Borrar la fila = restaurar.
-- Corre esto DESPUÉS de 001 a 008.
-- =====================================================================

create table if not exists flujo_config (
  clave text primary key,
  activo boolean,
  textos jsonb not null default '{}'::jsonb,
  params jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

grant all on flujo_config to service_role;
