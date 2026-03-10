# Shiprocket Integration – Delivery After Order

This document explains how Shiprocket is integrated with the admin panel to create shipments and deliver orders to customers, and what you need to do manually.

**Shiprocket support:** [https://support.shiprocket.in/support/home](https://support.shiprocket.in/support/home)  
**API docs:** [https://apidocs.shiprocket.in/](https://apidocs.shiprocket.in/)

---

## 1. What the integration does (automated)

From the **Admin Panel → Orders**, for each order you can:

1. **Create Shipment** – Sends the order to Shiprocket (adhoc order) using customer name, phone, address, and items from our order. Saves Shiprocket order ID and shipment ID on the order.
2. **Assign AWB** – Assigns an AWB (Air Waybill) and courier to the shipment. Saves AWB code and courier name on the order.
3. **Get Label** – Generates the shipping label PDF and opens it in a new tab. Saves the label URL on the order.
4. **Request Pickup** – Tells Shiprocket to schedule a pickup for the shipment (courier will come to your pickup address).
5. **Track** – Fetches tracking info for the AWB and shows it in the modal.

So: **create order in Shiprocket → assign AWB → get label → request pickup** is the flow the admin panel drives. Tracking is for checking status later.

---

## 2. What you must do manually

### 2.1 One-time setup

#### A. Create a Shiprocket account

- Sign up at [https://www.shiprocket.in/](https://www.shiprocket.in/).
- Complete KYC and add your **pickup address** (warehouse/shop) in Shiprocket.  
  This is where the courier will come to pick up packages.  
  Support: [How to create an order in Shiprocket](https://support.shiprocket.in/support/solutions/articles/152000000695-how-to-create-an-order-in-shiprocket-).

#### B. Create an API user and get credentials

1. In Shiprocket: **Settings → API → Configure**.
2. Click **Create an API User**.
3. Use an **email different from your Shiprocket login** and a strong password.
4. Click **Generate API Credential**.  
   You can create up to 4 API users.  
   Ref: [How to create an API user](https://support.shiprocket.in/support/solutions/articles/43000604103-how-to-create-an-api-user-can-i-have-more-than-one-api-users-).

#### C. Add credentials to the server

On the **server** (where `ijack-server` runs), add to `.env`:

```env
SHIPROCKET_EMAIL=your-api-user-email@example.com
SHIPROCKET_PASSWORD=your-api-user-password
SHIPROCKET_PICKUP_LOCATION=your-saved-pickup-location-name
SHIPROCKET_WEBHOOK_SECRET=your-random-webhook-secret
```

Use the **API user** email and password, not your main Shiprocket login.  
Restart the server after changing `.env`.

`SHIPROCKET_PICKUP_LOCATION` should match the exact pickup location name saved in Shiprocket, for example `work`.

`SHIPROCKET_WEBHOOK_SECRET` is optional but recommended. If you set it, add the same value as a custom header in Shiprocket webhook settings:

- Header name: `x-shiprocket-webhook-secret`
- Header value: your `SHIPROCKET_WEBHOOK_SECRET`

#### D. (Optional) Use test mode

To test the Shiprocket flow **without creating real shipments** and **without API credentials**:

1. In the server `.env`, add:
   ```env
   SHIPROCKET_TEST_MODE=true
   ```
2. Restart the server.
3. In Admin → Orders → View order → **Shiprocket Delivery**, you will see a **“Test mode”** badge.  
   **Create Shipment**, **Assign AWB**, **Get Label**, **Request Pickup**, and **Track** will all return **mock** data: no real API calls, no real shipments, no charges.  
   Use this to test the full flow before going live.

When you are ready for real shipments, remove `SHIPROCKET_TEST_MODE` (or set it to `false`) and add `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`.

---

## How to test creating a shipment

After you’ve created API credentials in Shiprocket’s dashboard:

### 1. Add credentials to the server

In your **ijack-server** project, add to `.env` (same folder as `index.js`):

```env
SHIPROCKET_EMAIL=your-api-user-email@example.com
SHIPROCKET_PASSWORD=your-api-user-password
```

Use the **API user** email and password you created in Shiprocket (Settings → API → Configure), not your main Shiprocket login.

### 2. Restart the server

```bash
cd ijack-server
npm start
```

(Or stop and start your dev server if you use `npm run dev`.)

### 3. (Optional) Verify config from the app

- Open your app (e.g. `http://localhost:3000`).
- Log in as **admin** (e.g. username `suraj`, password `ijack-newton`).
- Go to **Admin → All Orders**.
- Open any order (click **View**).
- Scroll to **Shiprocket Delivery**.
  - If you see **“Shiprocket is not configured”**, the server is not reading the env vars (check `.env` and restart).
  - If you see the **“1. Create Shipment”** button, Shiprocket is configured.

### 4. Use an order that can be shipped

You need at least one order that has:

- **Contact details** (name, email, phone)
- **Delivery address** (street, city, state, zipCode, country)
- **Items** (at least one product)

If you don’t have any orders yet:

- Log in as a **customer** (e.g. user1 / 1234), add items to cart, go to checkout, fill address and contact, and place an order (you can use a test/dummy payment if your setup allows).

### 5. Create the shipment in the admin panel

1. Go to **Admin → All Orders**.
2. Click **View** on the order you want to test.
3. In **Shiprocket Delivery**, click **“1. Create Shipment”**.
4. Wait a few seconds (button may show “...” while loading).

**Success:**  
- The section will update and show **SR Order** and **Shipment** IDs.  
- You’ll see the **“2. Assign AWB”** button.  
- In Shiprocket dashboard: **Orders** → you should see the new order.

**If you see an error:**

- **“Shiprocket not configured”**  
  → Add `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` to server `.env` and restart the server.

- **“Failed to get Shiprocket token”** or **401**  
  → Wrong API user email or password. Use the exact API user credentials from Shiprocket (Settings → API). The API user email is different from your Shiprocket login email.

- **“Order already created in Shiprocket”**  
  → This order was already sent to Shiprocket. Use another order or click **“2. Assign AWB”** to continue.

- **“Pincode not serviceable”** or similar  
  → The delivery pincode in the order may not be serviceable by Shiprocket. Try an order with a different pincode, or check serviceability in Shiprocket.

- **4xx/5xx from Shiprocket**  
  → Check the server terminal/logs for the full error. Often it’s missing/invalid address, pincode, or phone. Ensure the order has a valid Indian phone (10 digits) and pincode (6 digits).

### 6. Continue the flow (optional)

After **Create Shipment** works:

- Click **“2. Assign AWB”** to assign a courier and AWB.
- Click **“Get Label”** to generate and open the shipping label PDF.
- Click **“Request Pickup”** to tell Shiprocket to schedule a pickup from your pickup address (must be set in Shiprocket).
- Use **“Track”** (after AWB is assigned) to see tracking status.

---

### 2.2 For every order you want to ship

1. **Pack the order** and keep it ready at your pickup address.
2. In **Admin Panel → Orders**, open the order (View).
3. In the **Shiprocket Delivery** section:
   - Click **1. Create Shipment** (creates the order in Shiprocket).
   - Then **2. Assign AWB** (gets AWB and courier).
   - Then **Get Label** (download/print the shipping label).
   - Stick the **printed label** on the package.
   - Click **Request Pickup** so Shiprocket notifies the courier to pick up from your address.
4. Hand over the **packed and labeled** parcel to the courier when they arrive, or drop it at the courier’s facility if your plan allows it.

So the **manual** parts are: packing, printing and sticking the label, and handing over to the courier (or dropping off). The **automated** parts are: creating the order in Shiprocket, assigning AWB, generating the label PDF, and requesting pickup via the API.

---

## 3. Order of actions (recommended)

| Step | Action in admin panel | What happens | Your manual step |
|------|------------------------|--------------|-------------------|
| 1 | **Create Shipment** | Order is sent to Shiprocket; SR order ID and shipment ID are saved. | None. |
| 2 | **Assign AWB** | AWB and courier are assigned and saved on the order. | None. |
| 3 | **Get Label** | Label PDF is generated and opened; URL is saved. | **Print the label** and **stick it on the package**. |
| 4 | **Request Pickup** | Pickup is requested from Shiprocket for your pickup address. | **Keep the packed order ready** at the pickup address. |
| 5 | — | Courier arrives at your pickup address. | **Hand over the parcel** to the courier. |
| 6 | **Track** (optional) | You can click **Track** anytime to see status for the AWB. | None. |

---

## 4. API flow (for reference)

The server uses these Shiprocket APIs (see [API document helpsheet](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet)):

1. **POST** `https://apiv2.shiprocket.in/v1/external/auth/login`  
   – Login with API user email/password; get token (valid 240 hours).
2. **POST** `https://apiv2.shiprocket.in/v1/external/orders/create/adhoc`  
   – Create adhoc order (our “Create Shipment”).
3. **POST** `https://apiv2.shiprocket.in/v1/external/courier/assign/awb`  
   – Assign AWB to shipment (our “Assign AWB”).
4. **POST** `https://apiv2.shiprocket.in/v1/external/courier/generate/label`  
   – Generate label PDF (our “Get Label”).
5. **POST** `https://apiv2.shiprocket.in/v1/external/courier/generate/pickup`  
   – Request pickup (our “Request Pickup”).
6. **GET** `https://apiv2.shiprocket.in/v1/external/courier/track/awb/{awb_code}`  
   – Track by AWB (our “Track”).

Token is cached and refreshed when needed.

---

## 4.1 Real-time webhook setup

To receive shipment status changes automatically from Shiprocket:

1. Make sure your backend is publicly reachable over HTTPS.
2. In Shiprocket dashboard, go to **Settings → API → Webhooks**.
3. Enable the webhook toggle.
4. Set the webhook URL to:

   - Local testing through a tunnel: `https://your-public-url/api/delivery/webhook`
   - Production: `https://your-backend-domain/api/delivery/webhook`

   **Note:** Do not use keywords like shiprocket, kartrocket, sr, or kr in the URL (Shiprocket dashboard restriction). This endpoint uses `/api/delivery/webhook` for that reason.

5. If you set `SHIPROCKET_WEBHOOK_SECRET` in `.env`, add this custom header in Shiprocket:

   - `x-shiprocket-webhook-secret: <your secret>`

6. Save the webhook.

What the webhook updates in our app:

- `order.shiprocket.trackingStatus`
- `order.shiprocket.trackingUrl`
- `order.shiprocket.awbCode`
- `order.shiprocket.courierName`
- `order.shiprocket.lastWebhookAt`
- `order.status` when the shipment clearly maps to `shipped`, `delivered`, or `cancelled`

The admin **Orders** and **Shipments** pages will then show the latest webhook-fed shipment status.

---

## 5. Backend details

- **Config:** `config/shiprocket.js` – reads `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`, gets and caches token.
- **Public webhook route:** `POST /api/delivery/webhook` – receives real-time shipment updates from Shiprocket and updates matching orders in MongoDB. (Path avoids shiprocket/kartrocket/sr/kr in URL per Shiprocket’s webhook field rules.)
- **Routes:** `routes/shiprocket.js` – all under `/api/admin/shiprocket/*`, admin-only:
  - `GET /config` – whether Shiprocket is configured.
  - `POST /create-order` – body `{ orderId }` (our MongoDB order `_id`).
  - `POST /assign-awb` – body `{ orderId }`.
  - `POST /generate-label` – body `{ orderId }`.
  - `POST /generate-pickup` – body `{ orderId }`.
  - `GET /track/:awb` – track by AWB.
  - `POST /cancel` – body `{ orderId }`. Cancels any scheduled pickup first (if shipment has one), then cancels the Shiprocket order. Shiprocket does not auto-cancel pickup when the order is cancelled.
- **Order model:** Each order can have `shiprocket` with `orderId`, `shipmentId`, `awbCode`, `courierName`, `labelUrl`, etc.

Default package weight used for Shiprocket is **0.5 kg** (minimum chargeable). You can change `DEFAULT_WEIGHT_KG`, `DEFAULT_LENGTH`, `DEFAULT_BREADTH`, `DEFAULT_HEIGHT` in `routes/shiprocket.js` if needed.

---

## 6. Troubleshooting

| Issue | What to check |
|-------|----------------|
| “Shiprocket not configured” | `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` in server `.env`; restart server. |
| “Create Shiprocket order first” | Click **1. Create Shipment** before Assign AWB or Get Label. |
| “Failed to get Shiprocket token” | API user email/password correct; API user created in Shiprocket (Settings → API). |
| Pincode not serviceable | Check pincode in Shiprocket (e.g. [Serviceability](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet)); use a valid pickup pincode in your Shiprocket profile. |
| Label not opening | Pop-up blocker; or open the “Download Label” link from the order after **Get Label**. |

For more help: [Shiprocket Customer Support](https://support.shiprocket.in/support/home).

---

## 7. Summary

- **Automated:** Create order in Shiprocket, assign AWB, generate label, request pickup, and track via the admin panel.
- **Manual:** Sign up and KYC, set pickup address, create API user, add credentials to server `.env`, then for each order: pack, print and stick label, and hand over to courier (or drop off) after requesting pickup.

This gives you an automated flow from “order visible in admin” to “shipment created and pickup requested,” with clear manual steps for packing and handover.
