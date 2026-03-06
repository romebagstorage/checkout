// =============================================================
// POST /api/webhook
// Riceve eventi Stripe e invia email via EmailJS REST API
// =============================================================

const Stripe = require("stripe");

// ---- Disabilita il body parsing di Vercel (serve il raw body per la firma) ----
module.exports.config = { api: { bodyParser: false } };

// ---- Legge il raw body ----
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---- Invia email via EmailJS REST API ----
async function sendEmailJS(templateParams) {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    template_params: templateParams
  };

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`EmailJS error: ${response.status} — ${text}`);
  }

  return true;
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripe         = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody        = await getRawBody(req);
  const signature      = req.headers["stripe-signature"];

  let event;

  // ---- Verifica firma Stripe ----
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[webhook] Signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  // ---- Gestione evento ----
  if (event.type === "checkout.session.completed") {
    const session  = event.data.object;
    const metadata = session.metadata || {};

    console.log("[webhook] Checkout completed for:", metadata.name, metadata.email, "service:", metadata.service);

    // Parametri comuni per il template EmailJS
    const templateParams = {
      name:           metadata.name         || "-",
      phone:          metadata.phone        || "-",
      customer_email: metadata.email        || "-",
      service_type:   metadata.service_type || "-",
      date:           metadata.date         || "-",
      time:           metadata.time         || "-",
      pickup:         metadata.pickup       || "-",
      dropoff:        metadata.dropoff      || "-",
      notes:          metadata.notes        || "-",
      base_price:     metadata.base_price   || "-",
      night_fee:      metadata.night_fee    || "\u2014",
      total:          metadata.total        || "-",
    };

    // Campi specifici airport-transfer
    if (metadata.service === "airport-transfer") {
      templateParams.route  = metadata.route  || "-";
      templateParams.pax    = metadata.pax    || "-";
      templateParams.flight = metadata.flight || "-";
    }

    // Campi specifici luggage-valet
    if (metadata.service === "luggage-valet") {
      templateParams.route  = "-";
      templateParams.pax    = metadata.bags ? metadata.bags + " bags" : "-";
      templateParams.flight = "-";
    }

    try {
      await sendEmailJS(templateParams);
      console.log("[webhook] Email inviata con successo.");
    } catch (err) {
      console.error("[webhook] Errore invio email:", err.message);
    }
  }

  // ---- Conferma ricezione a Stripe ----
  return res.status(200).json({ received: true });
};
Book Rome airport transfer service - Claude
