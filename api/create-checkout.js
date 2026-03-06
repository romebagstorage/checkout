// =============================================================
// POST /api/create-checkout
// Riceve i dati del form e crea una Stripe Checkout Session
// Supporta: airport-transfer e luggage-valet
// =============================================================

const Stripe = require("stripe");

// ════════════════════════════════════════════════════════════════
// PREZZI AIRPORT TRANSFER (IVA 10% + POS 10% + markup €15 inclusi)
// ════════════════════════════════════════════════════════════════
const PRICES = {
  airport_departure_fco: { tier_1_3:  73, tier_4:  79, tier_5_6:  97, tier_7_8: 109 },
  airport_arrival_fco:   { tier_1_3:  76, tier_4:  82, tier_5_6: 100, tier_7_8: 112 },
  airport_departure_cia: { tier_1_3:  73, tier_4:  79, tier_5_6:  97, tier_7_8: 109 },
  airport_arrival_cia:   { tier_1_3:  76, tier_4:  82, tier_5_6: 100, tier_7_8: 112 },
};

// Supplemento notturno differenziato (21:30 – 05:30)
const NIGHT_FEES = {
  airport_departure_fco:  7,   // partenza dalla struttura
  airport_departure_cia:  7,
  airport_arrival_fco:   22,   // arrivo dall'aeroporto
  airport_arrival_cia:   22,
};

function paxTier(pax) {
  if (pax <= 3) return "tier_1_3";
  if (pax === 4) return "tier_4";
  if (pax <= 6) return "tier_5_6";
  return "tier_7_8";
}

function isNight(timeHHMM) {
  if (!timeHHMM) return false;
  const [h, m] = timeHHMM.split(":").map(Number);
  const mins = h * 60 + (m || 0);
  return mins >= 1290 || mins < 330;  // 21:30 – 05:30
}

function computeAirportPrice(route, pax, time) {
  const paxNum   = Math.min(Math.max(parseInt(pax, 10) || 1, 1), 8);
  const tier     = paxTier(paxNum);
  const routeMap = PRICES[route];
  if (!routeMap) return { base: 0, nightFee: 0, total: 0, night: false, paxNum };

  const base     = routeMap[tier] || 0;
  const night    = isNight(time);
  const nightFee = night ? (NIGHT_FEES[route] || 0) : 0;
  const total    = base + nightFee;

  return { base, nightFee, total, night, paxNum };
}

// ════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════
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
    const service = body.service || "airport-transfer";

    let session;

    // ──────────────────────────────────────────
    // SERVIZIO: AIRPORT TRANSFER
    // ──────────────────────────────────────────
    if (service === "airport-transfer") {
      const { name, phone, email, route, service_type, pax, date, time, flight, pickup, dropoff, notes, lang } = body;

      if (!name || !phone || !email || !route || !pax || !date || !time || !pickup || !dropoff) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const { base, nightFee, total, night, paxNum } = computeAirportPrice(route, pax, time);

      if (total === 0) {
        return res.status(400).json({ error: "Invalid route or pricing" });
      }

      const nightLabel = night ? ` + €${nightFee} night fee` : "";
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
          name, phone, email, route,
          service_type: service_type || "",
          pax:          String(paxNum),
          date, time,
          flight:       flight || "-",
          pickup, dropoff,
          notes:        notes || "-",
          base_price:   String(base),
          night_fee:    night ? `€${nightFee}` : "—",
          total:        `€${total}`,
          lang:         lang || "en"
        },
        success_url: `${process.env.SUCCESS_URL || "https://romebagstorage.com/thank-you"}?session_id={CHECKOUT_SESSION_ID}&lang=${lang || "en"}`,
        cancel_url:  process.env.CANCEL_URL_TRANSFER || "https://romebagstorage.com/airport-transfer/"
      });
    }

    // ──────────────────────────────────────────
    // SERVIZIO: LUGGAGE VALET
    // ──────────────────────────────────────────
    else if (service === "luggage-valet") {
      const { name, phone, email, date, time, service_type, bags, pickup, dropoff, notes, lang } = body;

      if (!name || !phone || !email || !date || !service_type || !bags || !pickup || !dropoff) {
        return res.status(400).json({ error: "Missing required fields" });
      }

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
          name, phone, email,
          service_type: serviceLabel,
          date,
          time:         time || "-",
          bags:         String(bagsNum),
          pickup, dropoff,
          notes:        notes || "-",
          base_price:   String(total),
          night_fee:    "—",
          total:        `€${total}`,
          lang:         lang || "en"
        },
        success_url: `${process.env.SUCCESS_URL || "https://romebagstorage.com/thank-you"}?session_id={CHECKOUT_SESSION_ID}&lang=${lang || "en"}`,
        cancel_url:  process.env.CANCEL_URL_VALET || "https://romebagstorage.com/luggage-valet-service/"
      });
    }

    // ──────────────────────────────────────────
    // SERVIZIO SCONOSCIUTO
    // ──────────────────────────────────────────
    else {
      return res.status(400).json({ error: `Unknown service: ${service}` });
    }

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("[create-checkout] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};
