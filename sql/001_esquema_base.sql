-- =====================================================================
-- Monitor JCF — Esquema base (reconstruido del sistema v1 en producción)
--
-- El sistema original creó estas tablas a mano en el SQL Editor de
-- Supabase — nunca existió un archivo .sql para ellas. Este archivo las
-- reconstruye a partir de las columnas que sí usa el código de v1
-- (webhook.mjs, admin-api.mjs, check-jcf-nacional.mjs,
-- telegram-webhook.mjs, heartbeat-jcf.mjs).
--
-- Corre esto PRIMERO, antes de 002_comercial_v2.sql y
-- 003_talkyria_real.sql, ÚNICAMENTE si el proyecto de Supabase está
-- vacío (no tiene ya estas tablas del sistema en producción). Si ya
-- existen, NO lo corras — usa directamente 002 y 003.
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists suscriptores (
  id bigint generated always as identity primary key,
  email text not null,
  estado text not null,
  municipio text not null,
  activo boolean not null default true,
  payment_id text,
  telegram_token text not null default gen_random_uuid()::text unique,
  telegram_chat_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_suscriptores_payment_id on suscriptores(payment_id);
create index if not exists idx_suscriptores_activo on suscriptores(activo);

-- Fila única (id=1) con la configuración global del periodo de monitoreo.
create table if not exists configuracion (
  id bigint primary key,
  registro_abierto boolean not null default false,
  periodo_inicio date,
  periodo_fin date,
  fecha_estimada_apertura date
);
insert into configuracion (id, registro_abierto)
values (1, false)
on conflict (id) do nothing;

create table if not exists historial_cambios (
  id bigint generated always as identity primary key,
  estado text,
  municipio text,
  estado_anterior text,
  estado_nuevo text,
  created_at timestamptz not null default now()
);
