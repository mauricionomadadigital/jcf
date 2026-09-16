-- =====================================================================
-- Monitor JCF — Migración v2 (panel comercial completo)
-- Ejecuta esto UNA VEZ en Supabase → SQL Editor, sobre el proyecto que
-- ya usa el sistema en producción. Es aditivo: no borra ni modifica
-- datos existentes, solo agrega columnas y tablas nuevas.
-- =====================================================================

-- 1) Suscriptores: plan, login, canales, referidos, ciclos -----------
alter table suscriptores
  add column if not exists plan text not null default 'vip'
    check (plan in ('free','vip')),
  add column if not exists password_hash text,
  add column if not exists phone text,
  add column if not exists email_enabled boolean not null default true,
  add column if not exists telegram_enabled boolean not null default true,
  add column if not exists call_enabled boolean not null default false,
  add column if not exists referral_code text unique,
  add column if not exists referred_by text,
  add column if not exists cycle_number int not null default 1,
  add column if not exists discount_percent int not null default 0,
  add column if not exists survey_result text
    check (survey_result in ('yes','no') or survey_result is null),
  add column if not exists survey_comment text,
  add column if not exists monto numeric,
  add column if not exists vip_started_at timestamptz,
  add column if not exists vip_expires_at timestamptz,
  add column if not exists reset_token text,
  add column if not exists reset_token_expires timestamptz;

-- Todo lo que ya existía en producción fue vendido como el único plan
-- pagado ($100 MXN) — lo etiquetamos 'vip' por default de aquí en
-- adelante para no romper el historial. El plan 'free' es el nuevo
-- registro sin costo.

-- 2) Sesiones de clientes (login correo + contraseña) ----------------
create table if not exists sesiones (
  token text primary key,
  suscriptor_id bigint not null references suscriptores(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_sesiones_suscriptor on sesiones(suscriptor_id);

-- 3) Historial de llamadas (Talkyria) ---------------------------------
create table if not exists llamadas (
  id bigint generated always as identity primary key,
  suscriptor_id bigint references suscriptores(id) on delete set null,
  email text,
  municipio text,
  estado text,
  evento text,                 -- clave anti-duplicado: suscriptor|municipio|apertura
  duracion_seg int,
  resultado text,               -- 'contestada' | 'no_contesto' | 'error'
  created_at timestamptz not null default now()
);
create unique index if not exists idx_llamadas_evento on llamadas(evento);

-- 4) Clics de referidos -------------------------------------------------
create table if not exists referral_clicks (
  code text primary key,
  clics int not null default 0,
  updated_at timestamptz not null default now()
);

-- 5) Configuración: fecha de encuesta + tutoriales + candados de UI ---
alter table configuracion
  add column if not exists encuesta_fecha date,
  add column if not exists siguiente_ciclo_fecha date,
  add column if not exists video1_url text,
  add column if not exists video2_url text,
  add column if not exists mostrar_lectura_real boolean not null default true,
  add column if not exists incluir_guia_documentos boolean not null default true,
  add column if not exists enviar_encuesta_final boolean not null default true;

-- 6) Índice para buscar suscriptor por email en el login ---------------
create index if not exists idx_suscriptores_email on suscriptores(email);
create index if not exists idx_suscriptores_referral_code on suscriptores(referral_code);
