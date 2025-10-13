// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();

/* =========================
   CORS: GitHub Pages origin
   ========================= */
const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // permitir llamadas sin Origin (curl/healthchecks)
    if (!origin) return cb(null, true);
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin), false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));

/* =====================================
   Supabase (server) con clave secreta
   ===================================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE, // ⚠️ solo en backend
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/* ===========================
   Auth middleware (JWT)
   =========================== */
async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Token requerido" });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Token inválido" });

    req.user = user;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    res.status(401).json({ error: "No autorizado" });
  }
}

/* ===========================
   Rutas existentes
   =========================== */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API Innovación Sindical activa", time: new Date().toISOString() });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Protegida: perfil básico
app.get("/profile", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    aud: req.user.aud,
    app_metadata: req.user.app_metadata,
  });
});

// Ejemplo CRUD básico (eco)
app.post("/reportes", requireAuth, async (req, res) => {
  const { titulo, contenido } = req.body || {};
  if (!titulo) return res.status(400).json({ error: "Falta título" });
  res.json({ ok: true, by: req.user.email, titulo, contenido });
});

/* ===========================================================
   NUEVO /escritor — SOLO "cuerpo" y "despedida" (sin encabezado)
   =========================================================== */
/**
 * POST /escritor
 * Headers: Authorization: Bearer <jwt supabase>
 * Body JSON (ejemplos):
 * {
 *   "tema": "Permiso sindical para asamblea",
 *   "tono": "formal",               // opcional: "formal" (default) | "neutral" | "enérgico" | etc.
 *   "hechos": [
 *      "Asamblea el 9 de octubre de 2025.",
 *      "Contrato contempla permiso con goce de sueldo."
 *   ],
 *   "extras": "Citar cláusula 12 del contrato colectivo.",
 *   "incluirDespedida": true        // por defecto true
 * }
 * Respuesta:
 * { "cuerpo": "...", "despedida": "..." }
 */
app.post("/escritor", requireAuth, async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY en el servidor" });
    }

    const {
      tema = "Escrito",
      tono = "formal",
      hechos = [],
      extras = "",
      incluirDespedida = true,
      longitud = "media"  // "breve" (~100-150 palabras), "media" (~180-260), "extensa" (~300-450)
    } = req.body || {};

    const longHint =
      longitud === "breve" ? "Extensión breve (100–150 palabras)." :
      longitud === "extensa" ? "Extensión amplia (300–450 palabras)." :
      "Extensión media (180–260 palabras).";

    // Prompt: instruimos que NO incluya fecha, destinatario, ni firma
    const prompt = [
      `Redacta ÚNICAMENTE el CUERPO del texto (sin encabezado, sin fecha, sin destinatario, sin firma).`,
      `Tema: ${tema}.`,
      `Tono: ${tono}. ${longHint}`,
      (hechos && hechos.length) ? `Hechos/puntos a tratar:\n- ${hechos.join("\n- ")}` : "",
      extras ? `Indicaciones adicionales: ${extras}` : "",
      incluirDespedida
        ? `Incluye al final una DESPEDIDA breve y profesional (p.ej., "Quedo atento a su respuesta.").`
        : `No incluyas despedida si no es necesario.`,
      `Debes responder en formato JSON válido con dos campos:`,
      `{"cuerpo":"<solo el cuerpo del mensaje, en párrafos>", "despedida":"<una sola línea de despedida o vacío si no aplica>"}.`,
      `No agregues nada antes o después del JSON.`
    ].filter(Boolean).join("\n");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente experto en redacción de textos formales en español. No incluyes encabezados (fecha, destinatario, remitente) ni firmas. Devuelves JSON válido."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 900
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status).json({ error: "OpenAI error", detail });
    }

    const data = await r.json();
    let content = data?.choices?.[0]?.message?.content || "";

    // Intentamos parsear el JSON que pedimos al modelo
    let cuerpo = "", despedida = "";
    try {
      // Si llega con espacios/markdown, extraer el bloque JSON
      const match = content.match(/\{[\s\S]*\}/);
      const jsonText = match ? match[0] : content;
      const obj = JSON.parse(jsonText);
      cuerpo = (obj.cuerpo || "").toString().trim();
      despedida = (obj.despedida || "").toString().trim();
    } catch {
      // Fallback: devolvemos todo como cuerpo
      cuerpo = content.trim();
      despedida = incluirDespedida ? "Quedo atento a su respuesta." : "";
    }

    res.json({ cuerpo, despedida });
  } catch (e) {
    console.error("escritor error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ===========================
   Arranque
   =========================== */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("✅ API escuchando en puerto", port));
