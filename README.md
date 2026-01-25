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

### Payment (PhonePe Integration)
- `POST /api/payment/initiate` - Initiate payment and create order (requires auth)
  - Creates an order in the database and initiates PhonePe payment
  - Returns `redirectUrl` to redirect user to PhonePe checkout page
- `GET /api/payment/status/:merchantOrderId` - Check payment status (requires auth)
  - Checks payment status with PhonePe API
  - Updates order status and stock quantities if payment is successful
- `POST /api/payment/webhook` - PhonePe webhook handler (no auth required)
  - Receives payment callbacks from PhonePe
  - Updates order status and stock quantities automatically

**PhonePe Configuration:**
Add the following to your `.env` file:
```env
PHONEPE_MERCHANT_ID=your-merchant-id
PHONEPE_SALT_KEY=your-salt-key
PHONEPE_SALT_INDEX=1
PHONEPE_CLIENT_ID=your-client-id
PHONEPE_CLIENT_SECRET=your-client-secret
PHONEPE_CLIENT_VERSION=1.0
PHONEPE_ENVIRONMENT=SANDBOX  # or PRODUCTION for live payments
FRONTEND_URL=https://your-frontend-url.com
BACKEND_URL=https://your-backend-url.com
```

**Note:** The integration uses PhonePe's Standard Checkout API v2. Make sure to configure the webhook URL in your PhonePe merchant dashboard.

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
