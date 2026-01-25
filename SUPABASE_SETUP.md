# Supabase Integration Setup Guide

This guide will help you set up Supabase PostgreSQL database to store order and financial data alongside MongoDB.

## Prerequisites

1. A Supabase account (sign up at https://supabase.com)
2. A Supabase project created

## Step 1: Install Dependencies

```bash
npm install @supabase/supabase-js
```

## Step 2: Get Supabase Credentials

1. Go to your Supabase Dashboard
2. Select your project
3. Navigate to **Settings** > **API**
4. Copy the following:
   - **Project URL** (this is your `SUPABASE_URL`)
   - **service_role key** (this is your `SUPABASE_SERVICE_ROLE_KEY`)
   - ⚠️ **Important**: Use the `service_role` key, not the `anon` key, as it has full database access

## Step 3: Create Database Tables

1. In your Supabase Dashboard, go to **SQL Editor**
2. Open the file `supabase-schema.sql` from this project
3. Copy and paste the entire SQL script into the SQL Editor
4. Click **Run** to execute the script
5. Verify that the tables `orders` and `order_items` were created successfully

## Step 4: Configure Environment Variables

Add the following to your `.env` file:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

Replace the values with your actual Supabase credentials.

## Step 5: Verify Integration

1. Start your server: `npm start`
2. Place a test order through your application
3. Check your Supabase Dashboard > **Table Editor** > **orders** to see if the order was synced
4. Check **order_items** table to see the order items

## How It Works

- **Dual Storage**: Orders are stored in both MongoDB (for application use) and Supabase (for financial reporting and analytics)
- **Automatic Sync**: When an order is created or updated, it's automatically synced to Supabase
- **Non-Blocking**: Supabase sync happens asynchronously, so it won't slow down your application if Supabase is unavailable
- **Error Handling**: If Supabase sync fails, the order still works in MongoDB - errors are logged but don't break the flow

## Database Schema

### `orders` Table
- Stores main order information
- Links to MongoDB via `mongodb_order_id`
- Includes payment status, customer info, and address

### `order_items` Table
- Stores individual items in each order
- References `orders` table via `order_id`

### Views
- **financial_summary**: Daily financial reports
- **order_details_view**: Detailed order view with items

## Querying Data

You can query the Supabase database directly using SQL or through the Supabase client:

```javascript
const { data, error } = await supabase
  .from('orders')
  .select('*')
  .eq('payment_status', 'SUCCESS')
  .order('created_at', { ascending: false });
```

## Troubleshooting

1. **Orders not syncing**: Check server logs for Supabase errors
2. **Connection issues**: Verify your `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
3. **Table errors**: Make sure you ran the SQL schema script in Supabase SQL Editor

## Security Notes

- The `service_role` key has full database access - keep it secure
- Never commit your `.env` file to version control
- Use environment variables in production
