# ijack-server

Node.js server with MongoDB integration for Ijack Notebooks ecommerce platform.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the root directory:

```env
PORT=5002
MONGODB_URI=mongodb://localhost:27017/ijack-notebooks
JWT_SECRET=your-secret-key-change-in-production
```

For MongoDB Atlas (cloud), use:

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/ijack-notebooks
```

3. Make sure MongoDB is running locally, or use MongoDB Atlas connection string.

4. Seed the database with dummy data (users and notebooks):

```bash
npm run seed
```

This will create:
- 5 dummy users (user1, user2, user3, user4, user5) with password "1234"
- 8 different notebook products

5. Start the server:

```bash
npm start
```

The server will run on `http://localhost:5002` (or the port specified in `.env`).

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (requires auth)

### Notebooks
- `GET /api/notebooks` - Get all notebooks
- `GET /api/notebooks/:id` - Get single notebook
- `POST /api/notebooks` - Create notebook (for seeding)

### Orders
- `POST /api/orders` - Create new order (requires auth)
- `GET /api/orders/my-orders` - Get user's orders (requires auth)
- `GET /api/orders/:id` - Get single order (requires auth)

### Payment (ZWITCH Layer Integration)
- `POST /api/payment/initiate` - Create order and get ZWITCH payment token (requires auth)
  - Creates an order in the database and calls ZWITCH Create Payment Token API
  - Returns `paymentToken`, `accessKey`, and `layerScriptUrl` for Layer.js checkout (no redirect)
- `GET /api/payment/status/:merchantOrderId` - Check payment status (requires auth)
  - Polls ZWITCH status API and updates order status and stock if payment is successful
- `POST /api/payment/webhook` - ZWITCH webhook handler (no auth required)
  - Receives payment events (e.g. payment_token_paid, payment_captured)
  - Verifies `x-zwitch-signature` and updates order status

**ZWITCH Configuration:**
Add the following to your `.env` file:
```env
ZWITCH_PG_ACCESS_KEY=your-pg-access-key
ZWITCH_PG_SECRET_KEY=your-pg-secret-key
ZWITCH_ENVIRONMENT=sandbox
ZWITCH_WEBHOOK_SIGNING_SECRET=your-webhook-signing-secret
FRONTEND_URL=https://your-frontend-url.com
BACKEND_URL=https://your-backend-url.com
```

**Note:** Get PG API Keys from [ZWITCH Dashboard](https://dashboard.zwitch.io) → Developers → PG API Keys. Set the webhook URL in the Dashboard (e.g. `https://your-backend-url.com/api/payment/webhook`) and use the same Signing Secret in `ZWITCH_WEBHOOK_SIGNING_SECRET`.

### GST Invoice & Email (Resend)
- When a payment succeeds, a **GST-compliant tax invoice** is generated (PDFKit) and emailed to the customer via [Resend](https://resend.com).
- Invoice PDFs are stored in Supabase Storage bucket **Invoices**; invoice data is stored in MongoDB (**Invoice** collection) so invoices can be regenerated or resent.
- **Create the Invoices bucket:** run `npm run create-invoices-bucket` or run `supabase-invoices-bucket.sql` in the Supabase SQL Editor.
- Admin **Invoices** (sidebar) lists all invoices with **View** (opens PDF from Supabase) and **Send** (resend email to customer).

### Supabase Integration (PostgreSQL for Financial Data & Storage)
- Orders are automatically synced to Supabase PostgreSQL database for financial reporting and analytics
- Product images are stored in Supabase Storage bucket `product-images`
- See `SUPABASE_SETUP.md` for database setup instructions
- See `SUPABASE_STORAGE_SETUP.md` for storage bucket setup instructions
- SQL schema file: `supabase-schema.sql`

**Supabase Configuration:**
Add the following to your `.env` file:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**Cleanup Script:**
To delete old product images from server folder:
```bash
npm run cleanup-images
```

### Shiprocket (Delivery)
- Admin can create shipments from orders and get labels/tracking via **Admin Panel → Orders → View → Shiprocket Delivery**.
- See `SHIPROCKET_INTEGRATION.md` for setup and manual steps.
- **Test mode:** Set `SHIPROCKET_TEST_MODE=true` in `.env` to test the flow without real API calls or shipments (no credentials needed).
- For live use, add to `.env` (use API user credentials from Shiprocket Settings → API):
```env
SHIPROCKET_EMAIL=your-api-user-email@example.com
SHIPROCKET_PASSWORD=your-api-user-password
```

### Health
- `GET /` - Welcome message
- `GET /health` - Health check with database connection status

## Project Structure

```
ijack-server/
├── config/
│   └── database.js         # MongoDB connection configuration
├── models/                 # Mongoose models
│   ├── User.js
│   ├── Notebook.js
│   └── Order.js
├── routes/                 # API routes
│   ├── auth.js
│   ├── notebooks.js
│   └── orders.js
├── middleware/
│   └── auth.js             # JWT authentication middleware
├── scripts/
│   └── seed.js             # Database seeding script
├── index.js                # Server entry point
├── package.json
└── .env                    # Environment variables (not in git)
```

## Dummy Data

After running `npm run seed`, you can login with:
- **Usernames:** user1, user2, user3, user4, user5
- **Password:** 1234 (for all users)
