-- =====================================================================
-- Inventario SCORP · rol «colaborador»
-- Ejecútelo una sola vez en Supabase → SQL Editor, después de 01_esquema.sql.
--
-- Un colaborador:
--   · ve todas las instalaciones activas de la isla, con todos sus datos;
--   · añade instalaciones en cualquier municipio;
--   · edita y mueve solo las instalaciones que él mismo añadió;
--   · no elimina, no restaura, no ve las eliminadas y no exporta.
-- =====================================================================

-- 1. El rol en la tabla de perfiles
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles drop constraint if exists perfil_municipio_segun_rol;
alter table public.perfiles add constraint perfiles_rol_check
  check (rol in ('municipio', 'admin', 'colaborador'));
alter table public.perfiles add constraint perfil_municipio_segun_rol check (
  (rol in ('admin', 'colaborador') and municipio_id is null) or
  (rol = 'municipio' and municipio_id is not null));

create or replace function public.es_colaborador() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from perfiles where user_id = auth.uid() and rol = 'colaborador') $$;

revoke execute on function public.es_colaborador() from public, anon;
grant execute on function public.es_colaborador() to authenticated;

-- 2. Validación al guardar: el colaborador puede ubicar puntos en cualquier municipio
create or replace function public.instalaciones_antes_de_guardar() returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  uid     uuid    := auth.uid();
  correo  text    := coalesce(auth.jwt() ->> 'email', current_user);
  admin   boolean := uid is null or public.es_admin();   -- uid nulo = SQL Editor o script con clave secreta
  libre   boolean := admin or public.es_colaborador();   -- puede ubicar puntos en cualquier municipio
  via_rpc boolean := coalesce(current_setting('scorp.via_funcion', true), '') = 'si';
  muni    text;
  t       text;
begin
  new.nombre           := btrim(new.nombre);
  new.tipo_otro        := nullif(btrim(new.tipo_otro), '');
  new.titularidad_otro := nullif(btrim(new.titularidad_otro), '');
  new.descripcion      := nullif(btrim(new.descripcion), '');

  if cardinality(new.tipos) <> (select count(distinct x) from unnest(new.tipos) x) then
    raise exception 'Hay tipos de instalación repetidos.' using errcode = '22023';
  end if;
  foreach t in array new.tipos loop
    if not exists (select 1 from catalogo_tipos where nombre = t) then
      raise exception 'Tipo de instalación desconocido: %', t using errcode = '22023';
    end if;
  end loop;

  if extensions.st_srid(new.geom) = 0 then new.geom := extensions.st_setsrid(new.geom, 4326); end if;
  select id into muni from municipios where extensions.st_intersects(geom, new.geom) order by id limit 1;
  if muni is null then
    raise exception 'El punto está fuera de los límites de los municipios.' using errcode = '22023';
  end if;
  if not libre and muni is distinct from public.mi_municipio() then
    raise exception 'Solo puede añadir o mover instalaciones dentro de su municipio, incluida su costa.' using errcode = '42501';
  end if;
  new.municipio_id := muni;

  if tg_op = 'INSERT' then
    new.creado_por := uid;  new.creado_por_correo := correo;  new.creado_en := now();
    new.modificado_por := null;  new.modificado_por_correo := null;  new.modificado_en := null;
    new.eliminado := false;
    new.eliminado_por := null;  new.eliminado_por_correo := null;  new.eliminado_en := null;
    return new;
  end if;

  new.id := old.id;
  new.creado_por := old.creado_por;  new.creado_por_correo := old.creado_por_correo;  new.creado_en := old.creado_en;

  if new.eliminado is distinct from old.eliminado then
    if not via_rpc and not (uid is null) then
      raise exception 'Use las funciones eliminar_instalacion o restaurar_instalacion.' using errcode = '42501';
    end if;
    if new.eliminado then
      new.eliminado_por := uid;  new.eliminado_por_correo := correo;  new.eliminado_en := now();
      new.modificado_por := old.modificado_por;  new.modificado_por_correo := old.modificado_por_correo;  new.modificado_en := old.modificado_en;
      return new;
    end if;
    new.eliminado_por := null;  new.eliminado_por_correo := null;  new.eliminado_en := null;
  else
    new.eliminado_por := old.eliminado_por;  new.eliminado_por_correo := old.eliminado_por_correo;  new.eliminado_en := old.eliminado_en;
  end if;

  new.modificado_por := uid;  new.modificado_por_correo := correo;  new.modificado_en := now();
  return new;
end $$;

-- 3. Reglas de acceso a las instalaciones
drop policy if exists "instalaciones: ver" on public.instalaciones;
drop policy if exists "instalaciones: añadir" on public.instalaciones;
drop policy if exists "instalaciones: editar" on public.instalaciones;

create policy "instalaciones: ver" on public.instalaciones
  for select to authenticated
  using (public.es_admin()
         or (public.es_colaborador() and not eliminado)
         or (municipio_id = public.mi_municipio() and not eliminado));

create policy "instalaciones: añadir" on public.instalaciones
  for insert to authenticated
  with check (public.es_admin() or public.es_colaborador() or municipio_id = public.mi_municipio());

create policy "instalaciones: editar" on public.instalaciones
  for update to authenticated
  using (public.es_admin()
         or (public.es_colaborador() and creado_por = auth.uid() and not eliminado)
         or (municipio_id = public.mi_municipio() and not eliminado))
  with check (public.es_admin()
         or (public.es_colaborador() and creado_por = auth.uid())
         or municipio_id = public.mi_municipio());

-- eliminar_instalacion y restaurar_instalacion no cambian: solo los municipios (sus puntos) y la
-- administración pueden eliminar, y solo la administración restaura.
