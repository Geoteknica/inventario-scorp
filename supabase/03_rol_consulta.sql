-- =====================================================================
-- Inventario SCORP · rol «consulta» (solo ver)
-- Ejecútelo una sola vez en Supabase → SQL Editor, después de 02_rol_colaborador.sql.
--
-- Una cuenta de consulta ve todas las instalaciones activas de la isla con todos sus datos.
-- No añade, no edita, no mueve, no elimina, no restaura, no ve las eliminadas y no exporta.
-- =====================================================================

-- 1. El rol en la tabla de perfiles
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles drop constraint if exists perfil_municipio_segun_rol;
alter table public.perfiles add constraint perfiles_rol_check
  check (rol in ('municipio', 'admin', 'colaborador', 'consulta'));
alter table public.perfiles add constraint perfil_municipio_segun_rol check (
  (rol in ('admin', 'colaborador', 'consulta') and municipio_id is null) or
  (rol = 'municipio' and municipio_id is not null));

create or replace function public.es_consulta() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from perfiles where user_id = auth.uid() and rol = 'consulta') $$;

revoke execute on function public.es_consulta() from public, anon;
grant execute on function public.es_consulta() to authenticated;

-- 2. Lectura: igual que el colaborador. Las reglas de añadir y editar no cambian,
--    así que una cuenta de consulta no cumple ninguna y no puede escribir nada.
drop policy if exists "instalaciones: ver" on public.instalaciones;
create policy "instalaciones: ver" on public.instalaciones
  for select to authenticated
  using (public.es_admin()
         or ((public.es_colaborador() or public.es_consulta()) and not eliminado)
         or (municipio_id = public.mi_municipio() and not eliminado));
