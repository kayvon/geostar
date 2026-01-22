-- GeoStar Energy Dashboard Schema

-- Energy readings from heat pumps (15-minute granularity)
CREATE TABLE IF NOT EXISTS energy_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,  -- Unix ms
  total_heat_1 REAL,
  total_heat_2 REAL,
  total_cool_1 REAL,
  total_cool_2 REAL,
  total_electric_heat REAL,
  total_fan_only REAL,
  total_loop_pump REAL,
  total_dehumidification REAL,
  runtime_heat_1 REAL,
  runtime_heat_2 REAL,
  runtime_cool_1 REAL,
  runtime_cool_2 REAL,
  runtime_electric_heat REAL,
  runtime_fan_only REAL,
  runtime_dehumidification REAL,
  total_power REAL,
  UNIQUE(gateway_id, timestamp)
);

-- Session storage for GeoStar authentication
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row
  session_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  created_at INTEGER NOT NULL  -- Unix ms
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_energy_gateway_time ON energy_readings(gateway_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_energy_time ON energy_readings(timestamp);
