-- Supabase PostgreSQL Schema for Ijack Notebooks Orders
-- Run this SQL in your Supabase SQL Editor to create the necessary tables

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  mongodb_order_id VARCHAR(255) UNIQUE NOT NULL,
  user_id VARCHAR(255),
  user_username VARCHAR(255),
  user_email VARCHAR(255),
  total_amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- Contact details
  contact_name VARCHAR(255),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  -- Address
  address_street TEXT,
  address_city VARCHAR(255),
  address_state VARCHAR(255),
  address_zip_code VARCHAR(50),
  address_country VARCHAR(255),
  -- Payment details
  payment_merchant_order_id VARCHAR(255),
  payment_transaction_id VARCHAR(255),
  payment_status VARCHAR(50) DEFAULT 'PENDING',
  payment_method VARCHAR(50) DEFAULT 'ONLINE',
  payment_amount DECIMAL(10, 2),
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create order_items table
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  notebook_id VARCHAR(255),
  notebook_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price DECIMAL(10, 2) NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_orders_mongodb_order_id ON orders(mongodb_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_notebook_id ON order_items(notebook_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create a view for financial reports
CREATE OR REPLACE VIEW financial_summary AS
SELECT 
  DATE_TRUNC('day', created_at) AS order_date,
  COUNT(*) AS total_orders,
  COUNT(CASE WHEN payment_status = 'SUCCESS' THEN 1 END) AS successful_orders,
  SUM(CASE WHEN payment_status = 'SUCCESS' THEN total_amount ELSE 0 END) AS total_revenue,
  AVG(CASE WHEN payment_status = 'SUCCESS' THEN total_amount END) AS average_order_value
FROM orders
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY order_date DESC;

-- Create a view for order details with items
CREATE OR REPLACE VIEW order_details_view AS
SELECT 
  o.id,
  o.mongodb_order_id,
  o.user_username,
  o.user_email,
  o.total_amount,
  o.status,
  o.payment_status,
  o.payment_transaction_id,
  o.created_at,
  json_agg(
    json_build_object(
      'notebook_name', oi.notebook_name,
      'quantity', oi.quantity,
      'price', oi.price,
      'subtotal', oi.subtotal
    )
  ) AS items
FROM orders o
LEFT JOIN order_items oi ON o.id = oi.order_id
GROUP BY o.id, o.mongodb_order_id, o.user_username, o.user_email, 
         o.total_amount, o.status, o.payment_status, o.payment_transaction_id, o.created_at;

-- Grant necessary permissions (adjust based on your Supabase setup)
-- These are typically handled by Supabase automatically, but you may need to adjust

COMMENT ON TABLE orders IS 'Stores order information synced from MongoDB';
COMMENT ON TABLE order_items IS 'Stores individual items within each order';
COMMENT ON VIEW financial_summary IS 'Daily financial summary of orders and revenue';
COMMENT ON VIEW order_details_view IS 'Detailed view of orders with their items';
