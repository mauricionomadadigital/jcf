-- =====================================================================
-- Monitor JCF — Migración v2.8
-- Admin > Flujo, fases 2 y 3:
-- 1) flujo_envios: cada mensaje que sale de una estación del flujo
--    (automático o manual), para los contadores por estación.
-- 2) flujo_disparos: historial de "Disparar ahora" (a todos o a uno).
-- Corre esto DESPUÉS de 001 a 009.
-- =====================================================================

create table if not exists flujo_envios (
  id bigint generated always as identity primary key,
  clave text not null,
  suscriptor_id bigint references suscriptores(id) on delete set null,
  canal text not null check (canal in ('telegram', 'correo')),
  ok boolean not null,
  manual boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_flujo_envios_clave_fecha on flujo_envios(clave, created_at desc);

create table if not exists flujo_disparos (
  id bigint generated always as identity primary key,
  clave text not null,
  alcance text not null check (alcance in ('todos', 'uno')),
  suscriptor_id bigint references suscriptores(id) on delete set null,
  destinatarios int not null default 0,
  enviados int not null default 0,
  fallidos int not null default 0,
  estado text not null default 'enviando' check (estado in ('enviando', 'terminado', 'error')),
  detalle text,
  created_at timestamptz not null default now(),
  terminado_en timestamptz
);

grant all on flujo_envios to service_role;
grant all on flujo_disparos to service_role;
