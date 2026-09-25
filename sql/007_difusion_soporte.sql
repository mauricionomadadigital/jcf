-- =====================================================================
-- Monitor JCF — Migración v2.5
-- 1) Difusiones: mensajes masivos por Telegram desde el panel admin,
--    a clientes VIP o a clientes Gratis (historial + conteo).
-- 2) Soporte: chat entre clientes VIP y el administrador. El cliente
--    escribe desde su panel o directo al bot de Telegram; el admin
--    contesta desde el panel admin y la respuesta llega por el bot.
-- Corre esto DESPUÉS de 001 a 006.
-- =====================================================================

create table if not exists difusiones (
  id bigint generated always as identity primary key,
  segmento text not null check (segmento in ('vip', 'free')),
  texto text not null,
  destinatarios int not null default 0,
  enviados int not null default 0,
  fallidos int not null default 0,
  estado text not null default 'enviando' check (estado in ('enviando', 'terminado', 'error')),
  created_at timestamptz not null default now(),
  terminado_en timestamptz
);

create table if not exists mensajes_soporte (
  id bigint generated always as identity primary key,
  suscriptor_id bigint not null references suscriptores(id) on delete cascade,
  autor text not null check (autor in ('cliente', 'admin')),
  canal text not null default 'panel' check (canal in ('panel', 'telegram')),
  texto text not null,
  leido boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_soporte_suscriptor on mensajes_soporte(suscriptor_id, created_at);
create index if not exists idx_soporte_no_leidos on mensajes_soporte(leido) where autor = 'cliente' and leido = false;

grant all on difusiones to service_role;
grant all on mensajes_soporte to service_role;
