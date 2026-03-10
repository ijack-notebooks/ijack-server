/**
 * Shiprocket API configuration and token helper
 * Base URL: https://apiv2.shiprocket.in
 * Docs: https://apidocs.shiprocket.in/
 * Support: https://support.shiprocket.in/support/home
 */

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const SHIPROCKET_PICKUP_LOCATION = process.env.SHIPROCKET_PICKUP_LOCATION;
const SHIPROCKET_WEBHOOK_SECRET = process.env.SHIPROCKET_WEBHOOK_SECRET || "";
const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in";

// When true, no real API calls; mock responses so you can test the admin flow without creating real shipments.
const SHIPROCKET_TEST_MODE = process.env.SHIPROCKET_TEST_MODE === "true" || process.env.SHIPROCKET_TEST_MODE === "1";

let cachedToken = null;
let tokenExpiry = null;
let cachedPickupLocation = SHIPROCKET_PICKUP_LOCATION || null;
const TOKEN_VALIDITY_MS = 9 * 24 * 60 * 60 * 1000; // 9 days (refresh before 10-day expiry)

function isTestMode() {
  return SHIPROCKET_TEST_MODE;
}

function isConfigured() {
  // In test mode, consider "configured" so admin UI shows Shiprocket section (no real credentials needed).
  if (SHIPROCKET_TEST_MODE) return true;
  return !!(SHIPROCKET_EMAIL && SHIPROCKET_PASSWORD);
}

async function getToken() {
  if (!isConfigured()) {
    throw new Error("Shiprocket credentials not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in .env");
  }
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  const response = await fetch(`${SHIPROCKET_BASE_URL}/v1/external/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: SHIPROCKET_EMAIL,
      password: SHIPROCKET_PASSWORD,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.token) {
    throw new Error(data.message || data.error || "Failed to get Shiprocket token");
  }
  cachedToken = data.token;
  tokenExpiry = Date.now() + TOKEN_VALIDITY_MS;
  return cachedToken;
}

async function shiprocketFetch(path, options = {}) {
  const token = await getToken();
  const url = path.startsWith("http") ? path : `${SHIPROCKET_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error || `Shiprocket API error: ${res.status}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json;
}

async function getPickupLocation() {
  if (SHIPROCKET_TEST_MODE) return "test-pickup";
  if (cachedPickupLocation) return cachedPickupLocation;

  const data = await shiprocketFetch("/v1/external/settings/company/pickup");
  const pickupLocations = data?.data?.shipping_address;
  const firstPickupLocation = Array.isArray(pickupLocations)
    ? pickupLocations.find((location) => location?.pickup_location)?.pickup_location
    : null;

  if (!firstPickupLocation) {
    throw new Error(
      "No Shiprocket pickup location found. Add a pickup address in Shiprocket or set SHIPROCKET_PICKUP_LOCATION in server .env",
    );
  }

  cachedPickupLocation = firstPickupLocation;
  return cachedPickupLocation;
}

module.exports = {
  SHIPROCKET_BASE_URL,
  SHIPROCKET_PICKUP_LOCATION,
  SHIPROCKET_WEBHOOK_SECRET,
  SHIPROCKET_TEST_MODE,
  isTestMode,
  isConfigured,
  getToken,
  getPickupLocation,
  shiprocketFetch,
};
