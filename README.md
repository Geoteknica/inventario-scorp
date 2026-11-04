# Inventario SCORP

Mapa web para que el personal de los 78 municipios de Puerto Rico identifique sus instalaciones de
recreación al aire libre, como parte de la actualización del Plan Integral de Recreación al Aire Libre (SCORP).

Este proyecto es liderado por Estudios Técnicos, Inc., bajo contrato (2026-000333) con el Departamento de
Recreación y Deportes (DRD). Es posible gracias a una subvención para planificación a través del programa
Land and Water Conservation Fund (LWCF, por sus siglas en inglés) del Servicio de Parques Nacionales (NPS,
por sus siglas en inglés) mediante la aportación P24AP01415 (proyecto 72-00178).

Página del proyecto: https://estudiostecnicos.com/proyectos-de-participacion-ciudadana/scorp2027-2032-2/

## Contenido

| Ruta | Qué es |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | El mapa web (sitio estático en GitHub Pages) |
| `config.js` | Dirección de Supabase y clave publicable |
| `data/municipios.json` | Límites simplificados de los 78 municipios, para dibujar el mapa |
| `data/limites/<GEOID>.json` | Límite completo de cada municipio, para dibujar el propio |
| `guia-inventario-scorp.pdf` | Guía de uso para el personal municipal |
| `supabase/01_esquema.sql` | Tablas, reglas de seguridad y funciones de la base de datos |
| `setup/configurar.mjs` | *No está en el repositorio.* Carga los límites y crea las 79 cuentas; se guarda solo en la computadora de la administración porque contiene la regla de las contraseñas |
| `supabase/02_rol_colaborador.sql` | Añade el rol «colaborador» |
| `setup/crear_colaborador.mjs` | Crea o actualiza una cuenta de colaborador |

## Puesta en marcha

1. **Base de datos.** En Supabase → SQL Editor, ejecute `supabase/01_esquema.sql` una sola vez.
2. **Cuentas y límites.** En la computadora de la administración, con Node 18 o más reciente y su copia local de `setup/configurar.mjs`:
   ```
   cd setup
   copy .env.ejemplo .env        (en Mac o Linux: cp .env.ejemplo .env)
   ```
   Complete `.env` con la clave secreta y la contraseña de administración, coloque
   `municipios_censo.geojson` en la carpeta `setup` y ejecute:
   ```
   node configurar.mjs
   ```
   El script escribe `setup/credenciales.csv` con las 79 cuentas. Ese archivo y `.env` no se suben a GitHub.
3. **Sitio.** En GitHub → Settings → Pages, publique desde la rama `main`, carpeta `/ (root)`.

## Cuentas de colaborador

| Rol | Ve | Añade | Edita y mueve | Elimina | Restaura y exporta |
| --- | --- | --- | --- | --- | --- |
| Municipio | Su municipio (de los vecinos, solo la ubicación) | En su municipio | Puntos de su municipio | Puntos de su municipio | No |
| Colaborador | Toda la isla, con todos los datos (sin las eliminadas) | En cualquier municipio | Solo lo que él añadió | No | No |
| Administración | Todo, incluidas las eliminadas | En cualquier municipio | Todo | Todo | Sí |

Para crear un colaborador, ejecute una vez `supabase/02_rol_colaborador.sql` en el SQL Editor y luego, desde `setup`:
```
node crear_colaborador.mjs correo@ejemplo.com "contraseña de al menos 10 caracteres"
```
Un punto que un colaborador añade dentro de un municipio pasa a formar parte del inventario de ese municipio,
que puede editarlo o eliminarlo como los suyos.

## Seguridad

- La clave publicable de `config.js` puede estar en el sitio: las reglas de la base de datos deciden qué
  puede ver y cambiar cada cuenta.
- La clave secreta solo va en `setup/.env`, nunca en el repositorio.
- Cada municipio ve y edita solo sus instalaciones; de los municipios vecinos ve únicamente la ubicación.
- Nada se borra: eliminar oculta la instalación, y la administración puede restaurarla.

Contacto: Roberto Moyano, Estudios Técnicos, Inc. · 787-751-1675 · rmoyano@estudiostecnicos.com
