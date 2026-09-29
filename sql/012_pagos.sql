-- =====================================================================
-- Monitor JCF — Migración v2.10
-- Historial completo de pagos: UNA FILA POR PAGO APROBADO de Mercado Pago
-- (la tabla suscriptores guarda una fila por persona, así que en una
-- renovación solo conservaba el último pago). Las métricas de ingresos,
-- la lista de pagos y los descuentos del admin salen de aquí.
-- Corre esto DESPUÉS de 001 a 011.
-- =====================================================================

create table if not exists pagos (
  id bigint generated always as identity primary key,
  payment_id text not null unique,               -- id del pago en Mercado Pago (idempotencia)
  suscriptor_id bigint references suscriptores(id) on delete set null,
  email text,                                     -- cuenta que subió a VIP
  pagador_email text,                             -- quien pagó en Mercado Pago (puede ser otra persona)
  monto numeric(10,2),
  descuento_aplicado int not null default 0,      -- cupón usado en este pago (0, 50, 70)
  ciclo int,
  estado text,
  municipio text,
  metodo text,                                    -- tarjeta, OXXO, SPEI… (payment_type_id)
  vip_desde timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_pagos_suscriptor on pagos(suscriptor_id);
create index if not exists idx_pagos_fecha on pagos(created_at desc);

grant all on pagos to service_role;

-- Pagos que ya existían (último pago guardado en cada suscriptor).
insert into pagos (payment_id, suscriptor_id, email, monto, ciclo, estado, municipio, vip_desde, created_at)
select payment_id, id, email, monto, cycle_number, estado, municipio, vip_started_at, coalesce(vip_started_at, created_at)
from suscriptores
where payment_id is not null
on conflict (payment_id) do nothing;
