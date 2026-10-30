// Configuración pública de la app.
// La llave pública (anon) de Supabase está hecha para ir en el navegador:
// lo que protege los datos son las reglas de acceso (RLS) de la base de datos,
// que solo dejan leer y escribir a usuarias con sesión iniciada.
window.CK_CONFIG = {
  supabaseUrl: 'https://wvrpnnrgwmlqgdangziy.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind2cnBubnJnd21scWdkYW5neml5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMzIwMjEsImV4cCI6MjEwODkwODAyMX0.Hw6t4IUW6nM95y224-OH1fW3XaWw-8EjJ07XQP4MLb4',
  // Se agrega al usuario cuando no lleva @ (ej. "evaluador" → evaluador@kawoq.demo)
  dominioUsuario: 'kawoq.demo',
  esDemo: true,
  metaConversion: 5
};
