-- ============================================================
-- Maze Sales Tracker IA — Generación automática del plan de cuotas
-- security definer: la dispara cualquier creador de venta (closer),
-- pero escribe st_cuotas como owner (la RLS de escritura es solo-admin).
-- Idempotente.
-- ============================================================

create or replace function public.st_regen_cuotas(p_sale public.st_sales)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_paid_count int;
  v_paid_sum   numeric;
  v_pagos_cierre int;
  v_n     int;
  v_resto numeric;
  v_monto numeric;
  v_i     int;
begin
  -- Las pagadas jamás se tocan; las pendientes se regeneran desde cero.
  delete from public.st_cuotas where sale_id = p_sale.id and status = 'pendiente';

  select count(*), coalesce(sum(paid_amount), 0)
    into v_paid_count, v_paid_sum
    from public.st_cuotas
   where sale_id = p_sale.id and status = 'pagada';

  v_resto := coalesce(p_sale.facturado, 0) - coalesce(p_sale.cash, 0)
             - coalesce(p_sale.reserva, 0) - v_paid_sum;
  if v_resto <= 0 then return; end if;

  -- "Cantidad de pagos" incluye el pago hecho al cierre (si entró cash).
  v_pagos_cierre := case when coalesce(p_sale.cash, 0) > 0 then 1 else 0 end;
  v_n := coalesce(p_sale.cuotas, 1) - v_pagos_cierre - v_paid_count;
  -- Hay resto pero el nro de pagos no deja cuotas -> una sola por el resto.
  if v_n < 1 then v_n := 1; end if;

  for v_i in 1..v_n loop
    v_monto := case when v_i = v_n
                 then v_resto - round(v_resto / v_n, 2) * (v_n - 1)
                 else round(v_resto / v_n, 2)
               end;
    insert into public.st_cuotas (org_id, sale_id, numero, monto, due_date)
    values (
      p_sale.org_id,
      p_sale.id,
      v_pagos_cierre + v_paid_count + v_i,
      v_monto,
      (p_sale.sale_date + make_interval(months => v_paid_count + v_i))::date
    );
  end loop;
end $$;

create or replace function public.st_cuotas_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.st_regen_cuotas(new);
  return new;
end $$;

drop trigger if exists st_sales_gen_cuotas on public.st_sales;
create trigger st_sales_gen_cuotas
  after insert or update of facturado, cash, reserva, cuotas, sale_date
  on public.st_sales
  for each row execute function public.st_cuotas_trg();
