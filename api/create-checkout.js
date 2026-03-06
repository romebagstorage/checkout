// =============================================================
// POST /api/create-checkout
// Riceve i dati del form e crea una Stripe Checkout Session
// Supporta: airport-transfer e luggage-valet
// =============================================================

const Stripe = require("stripe");

// ============================
// PREZZI — AIRPORT TRANSFER
// ============================
const AIRPORT_PRICES = { tier_1_3: 70, tier_4: 78, tier_5_6: 94, tier_7_8: 105 };
const NIGHT_FEE = 18;

function paxTier(pax) {
  if (pax <= 3) return "tier_1_3";
  if (pax === 4) return "tier_4";
  if (pax <= 6) return "tier_5_6";
  return "tier_7_8";
}

function isNight(timeHHMM) {
  if (!timeHHMM) return false;
  const [hh] = timeHHMM.split(":").map(Number);
  return hh >= 22 || hh < 6;
}

function computeAirportPrice(pax, time) {
  const paxNum = Math.min(Math.max(parseInt(pax, 10) || 1, 1), 8);
  const tier   = paxTier(paxNum);
  const night  = isNight(time);
  const base   = AIRPORT_PRICES[tier];
  const total  = base + (night ? NIGHT_FEE : 0);
  return { total, night, paxNum };
}

// ============================
// HANDLER
// ============================
module.exports = async function handler(req, res) {

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const body = req.body;
    const service = body.service || "airport-transfer"; // default

    let session;

    // ==========================================
    // SERVIZIO: AIRPORT TRANSFER
    // ==========================================
    if (service === "airport-transfer") {
      const { name, phone, email, route, service_type, pax, date, time, flight, pickup, dropoff, notes, lang } = body;

      if (!name || !phone || !email || !route || !pax || !date || !time || !pickup || !dropoff) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const { total, night, paxNum } = computeAirportPrice(pax, time);
      const nightLabel = night ? " + night fee" : "";
      const description = `${service_type || route} — ${paxNum} pax — ${date} ${time}${nightLabel}`;

      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: email,
        line_items: [{
          price_data: {
            currency: "eur",
            unit_amount: total * 100,
            product_data: {
              name: "Rome Airport Transfer",
              description: description
            }
          },
          quantity: 1
        }],
        metadata: {
          service:      "airport-transfer",
          name:         name,
          phone:        phone,
          email:        email,
          route:        route,
          service_type: service_type || "",
          pax:          String(paxNum),
          date:         date,
          time:         time,
          flight:       flight || "-",
          pickup:       pickup,
          dropoff:      dropoff,
          notes:        notes || "-",
          total:        String(total),
          night_fee:    night ? "Si (+€18)" : "No",
          lang:         lang || "en"
        },
        success_url: `${process.env.SUCCESS_URL || "https://romebagstorage.com/thank-you"}?session_id={CHECKOUT_SESSION_ID}&lang=${lang || "en"}`,
        cancel_url:  process.env.CANCEL_URL_TRANSFER || "https://romebagstorage.com/airport-transfer/"
      });
    }

    // ==========================================
    // SERVIZIO: LUGGAGE VALET
    // ==========================================
    else if (service === "luggage-valet") {
      const { name, phone, email, date, time, service_type, bags, pickup, dropoff, notes, lang } = body;

      if (!name || !phone || !email || !date || !service_type || !bags || !pickup || !dropoff) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // PREZZI LUGGAGE VALET
      const VALET_PRICES = { city: 40, airport: 70, port: 120 };
      const bagsNum = Math.min(Math.max(parseInt(bags, 10) || 1, 1), 6);
      const total = VALET_PRICES[service_type] || 40;

      const serviceLabel = service_type === "city" ? "City Pickup & Delivery"
                         : service_type === "airport" ? "Airport Pickup/Delivery"
                         : service_type === "port" ? "Civitavecchia Port Pickup/Delivery"
                         : service_type;
      const description = `Luggage Valet — ${serviceLabel} — ${bagsNum} bags — ${date}${time ? " " + time : ""}`;

      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: email,
        line_items: [{
          price_data: {
            currency: "eur",
            unit_amount: total * 100,
            product_data: {
              name: "Luggage Valet Service",
              description: description
            }
          },
          quantity: 1
        }],
        metadata: {
          service:      "luggage-valet",
          name:         name,
          phone:        phone,
          email:        email,
          service_type: serviceLabel,
          date:         date,
          time:         time || "-",
          bags:         String(bagsNum),
          pickup:       pickup,
          dropoff:      dropoff,
          notes:        notes || "-",
          total:        String(total),
          lang:         lang || "en"
        },
        success_url: `${process.env.SUCCESS_URL || "https://romebagstorage.com/thank-you"}?session_id={CHECKOUT_SESSION_ID}&lang=${lang || "en"}`,
        cancel_url:  process.env.CANCEL_URL_VALET || "https://romebagstorage.com/luggage-valet-service/"
      });
    }

    // ==========================================
    // SERVIZIO SCONOSCIUTO
    // ==========================================
    else {
      return res.status(400).json({ error: `Unknown service: ${service}` });
    }

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("[create-checkout] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};
