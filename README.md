# Clínica Kawoq · Contactos (antes Control de Leads)

App de seguimiento de personas interesadas para la Clínica Kawoq (Dra. Cindy Laines). Base de datos y acceso en Supabase; publicación en Netlify.

Caso práctico de la Certificación Vibe Coding (Convierte Más).

## Cómo está armada

- `index.html`, `css/`, `js/`: la app (sin paso de compilación).
- Base de datos y usuarias: Supabase (proyecto `ck-control-leads-demo`). Las reglas de cadencia, el tope de contactos y "No contactar" viven en la base de datos, para que la app y Lía calculen igual.
- Seguridad: solo usuarias con sesión leen o escriben (reglas por fila); nadie puede borrar registros; 5 intentos fallidos bloquean el ingreso 15 minutos.
- `netlify.toml`: publicación y encabezados de seguridad.

Esta copia es de demostración y solo contiene pacientes ficticios (P01 a P17).
