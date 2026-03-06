// =============================================================
// POST /api/create-checkout
// Riceve i dati del form e crea una Stripe Checkout Session
// Supporta: airport-transfer, city-tour e luggage-valet
// =============================================================

const Stripe = require("stripe");

// ════════════════════════════════════════════════════════════════
// PREZZI TRANSFER (IVA 10% + POS 10% + markup inclusi)
// ════════════════════════════════════════════════════════════════
const PRICES = {
  airport_departure_fco: { tier_1_3:  73, tier_4:  79, tier_5_6:  97, tier_7_8: 109 },
  airport_arrival_fco:   { tier_1_3:  76, tier_4:  82, tier_5_6: 100, tier_7_8: 112 },
  airport_departure_cia: { tier_1_3:  73, tier_4:  79, tier_5_6:  97, tier_7_8: 109 },
  airport_arrival_cia:   { tier_1_3:  76, tier_4:  82, tier_5_6: 100, tier_7_8: 112 },
  port_arrival_cvv:      { tier_1_3: 164, tier_4: 200, tier_5_6: 212, tier_7_8: 224 },
  port_departure_cvv:    { tier_1_3: 164, tier_4: 200, tier_5_6: 212, tier_7_8: 224 },
  city_tour:             { tier_1_3:  61, tier_4:  61, tier_5_6:  73, tier_7_8:  73 }, // prezzo PER ORA
};

// Supplemento notturno differenziato (21:30 – 06:00)
// Civitavecchia e city_tour: nessun supplemento notturno
const NIGHT_FEES = {
  airport_departure_fco:  7,   // partenza dalla struttura
  airport_departure_cia:  7,
  airport_arrival_fco:   22,   // arrivo dall'aeroporto
  airport_arrival_cia:   22,
  port_arrival_cvv:       0,
  port_departure_cvv:     0,
  city_tour:              0,
};

// Rotte con tariffa oraria
const HOURLY_ROUTES = ["city_tour"];

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
  return mins >= 1290 || mins < 360;  // 21:30 – 06:00
}

function computePrice(route, pax, time, hours) {
  const paxNum   = Math.min(Math.max(parseInt(pax, 10) || 1, 1), 8);
  const tier     = paxTier(paxNum);
  const routeMap = PRICES[route];
  if (!routeMap) return { base: 0, nightFee: 0, total: 0, night: false, paxNum, hours: 0, hourly: false, unitPrice: 0 };

  const hourly    = HOURLY_ROUTES.includes(route);
  const unitPrice = routeMap[tier] || 0;
  const hoursNum  = hourly ? Math.max(1, Math.min(12, parseInt(hours, 10) || 1)) : 0;
  const base      = hourly ? unitPrice * hoursNum : unitPrice;
  const night     = isNight(time);
  const nightFee  = night ? (NIGHT_FEES[route] || 0) : 0;
  const total     = base + nightFee;

  return { base, nightFee, total, night, paxNum, hours: hoursNum, hourly, unitPrice };
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
    // SERVIZIO: AIRPORT TRANSFER / PORT / CITY TOUR
    // ──────────────────────────────────────────
    if (service === "airport-transfer" || service === "city-tour") {
      const { name, phone, email, route, service_type, pax, date, time, flight, pickup, dropoff, notes, lang, hours } = body;

      const isHourly = HOURLY_ROUTES.includes(route);

      // Validazione campi richiesti
      if (!name || !phone || !email || !route || !pax || !date || !time || !pickup) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      if (!isHourly && !dropoff) {
        return res.status(400).json({ error: "Missing drop-off for transfer" });
      }

      const { base, nightFee, total, night, paxNum, hours: hoursNum, hourly, unitPrice } = computePrice(route, pax, time, hours);

      if (total === 0) {
        return res.status(400).json({ error: "Invalid route or pricing" });
      }

      // Descrizione per Stripe Checkout
      let description;
      if (hourly) {
        description = `${service_type || route} — ${paxNum} pax — ${hoursNum}h — ${date} ${time}`;
      } else {
        const nightLabel = night && nightFee > 0 ? ` + €${nightFee} night fee` : "";
        description = `${service_type || route} — ${paxNum} pax — ${date} ${time}${nightLabel}`;
      }

      // Nome prodotto in base al tipo
      let productName = "Rome Airport Transfer";
      if (route.startsWith("port_")) productName = "Rome–Civitavecchia Transfer";
      if (route === "city_tour") productName = "Rome City Companion";

      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: email,
        line_items: [{
          price_data: {
            currency: "eur",
            unit_amount: total * 100,
            product_data: {
              name: productName,
              description: description
            }
          },
          quantity: 1
        }],
        metadata: {
          service:      service,
          name, phone, email, route,
          service_type: service_type || "",
          pax:          String(paxNum),
          date, time,
          flight:       flight || "-",
          pickup,
          dropoff:      dropoff || "-",
          notes:        notes || "-",
          base_price:   String(base),
          night_fee:    night && nightFee > 0 ? `€${nightFee}` : "—",
          total:        `€${total}`,
          hours:        hourly ? String(hoursNum) : "-",
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
