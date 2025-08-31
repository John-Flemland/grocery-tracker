// Grocery Price Tracker API
// This connects to your PostgreSQL database and serves the mobile app

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve HTML file

// Connect to your PostgreSQL database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected successfully');
  }
});


// ROUTE 1: Get all tracked ingredients with current pricing (SIMPLE FIX)
app.get('/api/ingredients', async (req, res) => {
    try {
      console.log('📋 Getting ingredients list...');
      
      const result = await pool.query(`
        SELECT 
          p.ingredient,
          p.category,
          COUNT(DISTINCT p.sku) as product_count,
          MIN(ph.price) as min_effective_price,
          'unit' as standard_unit,
          'Stable' as price_trend
        FROM tesco_products p
        JOIN tesco_price_history ph ON p.sku = ph.sku
        WHERE p.ingredient IS NOT NULL
        GROUP BY p.ingredient, p.category
        ORDER BY p.ingredient
      `);
      
      console.log(`✅ Found ${result.rows.length} ingredients`);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Error getting ingredients:', err);
      res.status(500).json({ error: err.message });
    }
  });

// ROUTE 2: Get price history for specific ingredient
app.get('/api/ingredient-price-history/:ingredient/:days', async (req, res) => {
  const { ingredient, days } = req.params;
  
  try {
    console.log(`📈 Getting price history for ${ingredient} (${days} days)...`);
    
    // Get price history
    const priceHistory = await pool.query(`
      SELECT 
        p.brand,
        p.full_name,
        p.package_size,
        p.unit,
        ph.price,
        ph.loyalty_price,
        ph.deal_savings_percentage,
        ph.scraped_at::date as date,
        ph.deal_valid_until,
        
        -- Calculate price per standard unit
        CASE 
          WHEN p.unit IN ('g', 'ml') THEN (COALESCE(ph.loyalty_price, ph.price) / p.package_size) * 1000
          WHEN p.unit IN ('kg', 'l') THEN COALESCE(ph.loyalty_price, ph.price) / p.package_size
          ELSE COALESCE(ph.loyalty_price, ph.price)
        END as price_per_standard_unit
        
      FROM tesco_price_history ph
      JOIN tesco_products p ON ph.sku = p.sku
      WHERE LOWER(p.ingredient) = LOWER($1)
        AND ph.scraped_at >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
      ORDER BY ph.scraped_at, p.brand
    `, [ingredient]);

    // Calculate statistics
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as data_points,
        MIN(COALESCE(ph.loyalty_price, ph.price)) as min_price,
        MAX(COALESCE(ph.loyalty_price, ph.price)) as max_price,
        AVG(COALESCE(ph.loyalty_price, ph.price)) as avg_price,
        (SELECT COALESCE(ph2.loyalty_price, ph2.price) 
         FROM tesco_price_history ph2 
         JOIN tesco_products p2 ON ph2.sku = p2.sku
         WHERE LOWER(p2.ingredient) = LOWER($1)
         ORDER BY ph2.scraped_at DESC LIMIT 1) as current_price,
        COUNT(*) FILTER (WHERE ph.deal_savings_percentage > 0) as deal_count
      FROM tesco_price_history ph
      JOIN tesco_products p ON ph.sku = p.sku
      WHERE LOWER(p.ingredient) = LOWER($1)
        AND ph.scraped_at >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
    `, [ingredient]);

    // Simple deal pattern analysis
    const dealPattern = await analyzeDealPattern(ingredient);
    
    console.log(`✅ Found ${priceHistory.rows.length} price points for ${ingredient}`);
    
    res.json({
      price_history: priceHistory.rows,
      stats: stats.rows[0],
      deal_pattern: dealPattern
    });
    
  } catch (err) {
    console.error('❌ Error getting price history:', err);
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 3: Buy Now Signals (items at historic lows or great deals)
app.get('/api/buy-now-signals', async (req, res) => {
  try {
    console.log('🎯 Finding buy now signals...');
    
    const result = await pool.query(`
      WITH price_analysis AS (
        SELECT 
          p.ingredient,
          p.brand,
          p.full_name,
          p.package_size,
          p.unit,
          latest.price,
          latest.loyalty_price,
          latest.deal_savings_percentage,
          latest.deal_valid_until,
          
          -- Historical price context
          MIN(ph.price) as historic_low,
          AVG(ph.price) as avg_historical_price,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ph.price) as price_25th_percentile,
          
          -- Current effective price
          COALESCE(latest.loyalty_price, latest.price) as effective_price
          
        FROM tesco_products p
        JOIN LATERAL (
          SELECT * FROM tesco_price_history ph_latest
          WHERE ph_latest.sku = p.sku 
          ORDER BY scraped_at DESC LIMIT 1
        ) latest ON true
        JOIN tesco_price_history ph ON p.sku = ph.sku
        WHERE ph.scraped_at >= CURRENT_DATE - INTERVAL '60 days'
          AND p.ingredient IS NOT NULL
        GROUP BY p.ingredient, p.brand, p.full_name, p.package_size, p.unit,
                 latest.price, latest.loyalty_price, latest.deal_savings_percentage, latest.deal_valid_until
      )
      SELECT *,
        CASE 
          WHEN effective_price <= historic_low * 1.05 THEN 'At historic low'
          WHEN effective_price <= price_25th_percentile THEN 'Bottom 25% of prices'
          WHEN deal_savings_percentage >= 25 THEN 'Excellent deal (25%+ off)'
          WHEN deal_savings_percentage >= 20 THEN 'Great deal (20%+ off)'
          ELSE 'Good value'
        END as reason,
        (avg_historical_price - effective_price) as potential_savings
      FROM price_analysis
      WHERE 
        -- Buy signals
        (effective_price <= historic_low * 1.05)  -- At or near historic low
        OR (effective_price <= price_25th_percentile)  -- Bottom quartile
        OR (deal_savings_percentage >= 20)  -- Great deal
      ORDER BY 
        CASE 
          WHEN effective_price <= historic_low * 1.05 THEN 1
          WHEN deal_savings_percentage >= 25 THEN 2
          ELSE 3
        END,
        potential_savings DESC NULLS LAST
      LIMIT 20
    `);
    
    console.log(`✅ Found ${result.rows.length} buy now signals`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error getting buy signals:', err);
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 4: Wait Signals (items likely to go on sale soon)
app.get('/api/wait-signals', async (req, res) => {
  try {
    console.log('⏳ Finding wait signals...');
    
    const result = await pool.query(`
      WITH price_analysis AS (
        SELECT 
          p.ingredient,
          p.brand,
          p.full_name,
          p.package_size,
          p.unit,
          latest.price,
          latest.loyalty_price,
          
          -- Historical analysis
          AVG(ph.price) as avg_price,
          MIN(ph.price) as min_price,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ph.price) as price_75th_percentile,
          
          -- Deal frequency
          COUNT(*) FILTER (WHERE ph.deal_savings_percentage > 15) as deal_count,
          COUNT(*) as total_observations,
          
          -- Days since last deal
          (CURRENT_DATE - MAX(ph.scraped_at::date) FILTER (WHERE ph.deal_savings_percentage > 15)) as days_since_deal,
          
          COALESCE(latest.loyalty_price, latest.price) as current_price
          
        FROM tesco_products p
        JOIN LATERAL (
          SELECT * FROM tesco_price_history ph_latest
          WHERE ph_latest.sku = p.sku 
          ORDER BY scraped_at DESC LIMIT 1
        ) latest ON true
        JOIN tesco_price_history ph ON p.sku = ph.sku
        WHERE ph.scraped_at >= CURRENT_DATE - INTERVAL '60 days'
          AND p.ingredient IS NOT NULL
        GROUP BY p.ingredient, p.brand, p.full_name, p.package_size, p.unit,
                 latest.price, latest.loyalty_price
      )
      SELECT *,
        CASE 
          WHEN current_price >= price_75th_percentile AND deal_count >= 3 
            THEN 'Frequent deals, currently expensive'
          WHEN current_price > avg_price * 1.1 
            THEN 'Above average price'
          WHEN days_since_deal >= 14 AND deal_count >= 2 
            THEN 'Deal likely due soon'
          ELSE 'Price may drop'
        END as reason,
        min_price as expected_price
      FROM price_analysis
      WHERE 
        -- Wait signals
        (current_price >= price_75th_percentile AND deal_count >= 3)  -- Usually has deals, currently expensive
        OR (current_price > avg_price * 1.15)  -- Well above average
        OR (days_since_deal >= 14 AND deal_count >= 2)  -- Regular deals, been a while
      ORDER BY 
        (current_price - min_price) DESC,  -- Biggest potential savings
        days_since_deal DESC NULLS LAST
      LIMIT 15
    `);
    
    console.log(`✅ Found ${result.rows.length} wait signals`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error getting wait signals:', err);
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 5: Expiring deals
app.get('/api/expiring-deals', async (req, res) => {
  try {
    console.log('⏰ Finding expiring deals...');
    
    const result = await pool.query(`
      SELECT 
        p.ingredient,
        p.brand,
        p.full_name,
        p.package_size,
        p.unit,
        ph.price,
        ph.loyalty_price,
        ph.deal_savings_percentage,
        ph.deal_valid_until,
        
        EXTRACT(days FROM (ph.deal_valid_until - CURRENT_DATE)) as days_until_expiry
        
      FROM tesco_products p
      JOIN LATERAL (
        SELECT * FROM tesco_price_history ph_latest
        WHERE ph_latest.sku = p.sku 
        ORDER BY scraped_at DESC LIMIT 1
      ) ph ON true
      WHERE ph.deal_valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '5 days'
        AND ph.deal_savings_percentage > 10
        AND p.ingredient IS NOT NULL
      ORDER BY ph.deal_valid_until ASC, ph.deal_savings_percentage DESC
      LIMIT 20
    `);
    
    console.log(`✅ Found ${result.rows.length} expiring deals`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error getting expiring deals:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to analyze deal patterns
async function analyzeDealPattern(ingredient) {
  try {
    const result = await pool.query(`
      WITH deal_dates AS (
        SELECT 
          ph.scraped_at::date as deal_date,
          ph.deal_savings_percentage
        FROM tesco_price_history ph
        JOIN tesco_products p ON ph.sku = p.sku
        WHERE LOWER(p.ingredient) = LOWER($1)
          AND ph.deal_savings_percentage > 15
          AND ph.scraped_at >= CURRENT_DATE - INTERVAL '90 days'
        ORDER BY ph.scraped_at
      ),
      deal_gaps AS (
        SELECT 
          deal_date,
          LAG(deal_date) OVER (ORDER BY deal_date) as prev_deal_date,
          deal_date - LAG(deal_date) OVER (ORDER BY deal_date) as days_between_deals
        FROM deal_dates
      )
      SELECT 
        COUNT(*) as total_deals,
        AVG(days_between_deals) as avg_days_between_deals,
        (CURRENT_DATE - MAX(deal_date)) as days_since_last_deal,
        CASE 
          WHEN COUNT(*) >= 4 THEN 'FREQUENT'
          WHEN COUNT(*) >= 2 THEN 'OCCASIONAL'
          ELSE 'RARE'
        END as frequency
      FROM deal_gaps
      WHERE days_between_deals IS NOT NULL
    `, [ingredient]);

    const pattern = result.rows[0];
    
    if (!pattern || pattern.total_deals === 0) {
      return {
        frequency: 'RARE',
        recommendation: 'Buy when needed, deals are unpredictable'
      };
    }

    let recommendation;
    if (pattern.frequency === 'FREQUENT') {
      if (pattern.days_since_last_deal > pattern.avg_days_between_deals * 1.5) {
        recommendation = 'Deal likely soon - consider waiting';
      } else {
        recommendation = 'Regular deal pattern - buy when discounted';
      }
    } else if (pattern.frequency === 'OCCASIONAL') {
      recommendation = 'Deals are less predictable - buy at 15%+ discount';
    } else {
      recommendation = 'Buy when needed, deals are rare';
    }

    return {
      ...pattern,
      avg_days_between_deals: Math.round(pattern.avg_days_between_deals || 0),
      days_since_last_deal: pattern.days_since_last_deal || 0,
      recommendation
    };
    
  } catch (error) {
    console.error('Error analyzing deal pattern:', error);
    return {
      frequency: 'UNKNOWN',
      recommendation: 'Unable to analyze deal pattern'
    };
  }
}

// Serve the mobile app at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Mobile Grocery Price Tracker'
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛒 Mobile Grocery Price Tracker running on port ${PORT}`);
  console.log(`📱 Open in browser: http://localhost:${PORT}`);
  console.log(`🔍 API available at: http://localhost:${PORT}/api/ingredients`);
});

module.exports = app;