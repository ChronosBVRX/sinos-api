import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();

// CORS: permite solo tu dominio de GitHub Pages
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  credentials: true,
}));

app.use(express.json());

// Cliente Supabase (server-side con clave secreta)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Middleware para validar JWT
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Token inválido" });

  req.user = user;
  next();
}

// Ruta pública
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API Innovación Sindical activa", time: new Date().toISOString() });
});

// Ruta protegida
app.get("/profile", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    aud: req.user.aud,
    app_metadata: req.user.app_metadata,
  });
});

// Ejemplo CRUD básico
app.post("/reportes", requireAuth, async (req, res) => {
  const { titulo, contenido } = req.body || {};
  if (!titulo) return res.status(400).json({ error: "Falta título" });
  res.json({ ok: true, by: req.user.email, titulo, contenido });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("✅ API escuchando en puerto", port));
