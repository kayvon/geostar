import type { D1Database } from '@cloudflare/workers-types';
import type { EnergyReading } from './geostar-client';

export interface StoredEnergyReading extends EnergyReading {
  id: number;
  gateway_id: string;
}

/**
 * Get the UTC offset in milliseconds for a given timezone on a given date.
 * Handles DST automatically via the Intl API.
 * E.g., America/Los_Angeles in winter returns -28800000 (UTC-8)
 */
function getTimezoneOffsetMs(timezone: string, dateStr: string): number {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const formatted = formatter.format(date);
  const match = formatted.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2]);
  const minutes = parseInt(match[3]);
  return sign * (hours * 3600000 + minutes * 60000);
}

/**
 * Insert energy readings into the database
 * Uses INSERT OR IGNORE to skip duplicates (based on UNIQUE constraint)
 */
export async function insertEnergyReadings(
  db: D1Database,
  gatewayId: string,
  readings: EnergyReading[]
): Promise<{ inserted: number; skipped: number }> {
  if (readings.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO energy_readings (
      gateway_id, timestamp,
      total_heat_1, total_heat_2, total_cool_1, total_cool_2,
      total_electric_heat, total_fan_only, total_loop_pump, total_dehumidification,
      runtime_heat_1, runtime_heat_2, runtime_cool_1, runtime_cool_2,
      runtime_electric_heat, runtime_fan_only, runtime_dehumidification,
      total_power
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Batch insert using D1 batch
  const statements = readings.map((r) =>
    stmt.bind(
      gatewayId,
      r.timestamp,
      r.total_heat_1,
      r.total_heat_2,
      r.total_cool_1,
      r.total_cool_2,
      r.total_electric_heat,
      r.total_fan_only,
      r.total_loop_pump,
      r.total_dehumidification,
      r.runtime_heat_1,
      r.runtime_heat_2,
      r.runtime_cool_1,
      r.runtime_cool_2,
      r.runtime_electric_heat,
      r.runtime_fan_only,
      r.runtime_dehumidification,
      r.total_power
    )
  );

  const results = await db.batch(statements);

  let inserted = 0;
  for (const result of results) {
    if (result.meta.changes > 0) {
      inserted++;
    }
  }

  return { inserted, skipped: readings.length - inserted };
}

/**
 * Get daily energy totals grouped by date
 */
export async function getDailyTotals(
  db: D1Database,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  timezone: string = 'America/Los_Angeles'
): Promise<DailyTotal[]> {
  // Convert date boundaries to UTC timestamps adjusted for the target timezone
  const offsetMs = getTimezoneOffsetMs(timezone, startDate);
  const startTs = new Date(`${startDate}T00:00:00Z`).getTime() - offsetMs;
  const endTs = new Date(`${endDate}T23:59:59Z`).getTime() - offsetMs;

  const results = await db
    .prepare(`
      SELECT
        date((timestamp + ?) /1000, 'unixepoch') as date,
        gateway_id,
        SUM(total_heat_1) as total_heat_1,
        SUM(total_heat_2) as total_heat_2,
        SUM(total_cool_1) as total_cool_1,
        SUM(total_cool_2) as total_cool_2,
        SUM(total_electric_heat) as total_electric_heat,
        SUM(total_fan_only) as total_fan_only,
        SUM(total_loop_pump) as total_loop_pump,
        SUM(total_dehumidification) as total_dehumidification,
        SUM(runtime_heat_1) as runtime_heat_1,
        SUM(runtime_heat_2) as runtime_heat_2,
        SUM(runtime_cool_1) as runtime_cool_1,
        SUM(runtime_cool_2) as runtime_cool_2,
        SUM(total_power) as total_power,
        COUNT(*) as reading_count
      FROM energy_readings
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY date, gateway_id
      ORDER BY date DESC, gateway_id
    `)
    .bind(offsetMs, startTs, endTs)
    .all<DailyTotalRow>();

  return (results.results || []).map(row => ({
    date: row.date,
    gatewayId: row.gateway_id,
    totalHeat1: row.total_heat_1,
    totalHeat2: row.total_heat_2,
    totalCool1: row.total_cool_1,
    totalCool2: row.total_cool_2,
    totalElectricHeat: row.total_electric_heat,
    totalFanOnly: row.total_fan_only,
    totalLoopPump: row.total_loop_pump,
    totalDehumidification: row.total_dehumidification,
    runtimeHeat1: row.runtime_heat_1,
    runtimeHeat2: row.runtime_heat_2,
    runtimeCool1: row.runtime_cool_1,
    runtimeCool2: row.runtime_cool_2,
    totalPower: row.total_power,
    readingCount: row.reading_count,
  }));
}

export interface DailyTotal {
  date: string;
  gatewayId: string;
  totalHeat1: number;
  totalHeat2: number;
  totalCool1: number;
  totalCool2: number;
  totalElectricHeat: number;
  totalFanOnly: number;
  totalLoopPump: number;
  totalDehumidification: number;
  runtimeHeat1: number;
  runtimeHeat2: number;
  runtimeCool1: number;
  runtimeCool2: number;
  totalPower: number;
  readingCount: number;
}

interface DailyTotalRow {
  date: string;
  gateway_id: string;
  total_heat_1: number;
  total_heat_2: number;
  total_cool_1: number;
  total_cool_2: number;
  total_electric_heat: number;
  total_fan_only: number;
  total_loop_pump: number;
  total_dehumidification: number;
  runtime_heat_1: number;
  runtime_heat_2: number;
  runtime_cool_1: number;
  runtime_cool_2: number;
  total_power: number;
  reading_count: number;
}

/**
 * Get hourly energy totals for a specific date
 */
export async function getHourlyTotals(
  db: D1Database,
  date: string,  // YYYY-MM-DD
  timezone: string = 'America/Los_Angeles'
): Promise<HourlyTotal[]> {
  const offsetMs = getTimezoneOffsetMs(timezone, date);
  const startTs = new Date(`${date}T00:00:00Z`).getTime() - offsetMs;
  const endTs = new Date(`${date}T23:59:59Z`).getTime() - offsetMs;

  const results = await db
    .prepare(`
      SELECT
        strftime('%H', (timestamp + ?) /1000, 'unixepoch') as hour,
        gateway_id,
        SUM(total_heat_1) as total_heat_1,
        SUM(total_heat_2) as total_heat_2,
        SUM(total_cool_1) as total_cool_1,
        SUM(total_cool_2) as total_cool_2,
        SUM(total_electric_heat) as total_electric_heat,
        SUM(total_power) as total_power,
        COUNT(*) as reading_count
      FROM energy_readings
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY hour, gateway_id
      ORDER BY hour, gateway_id
    `)
    .bind(offsetMs, startTs, endTs)
    .all<HourlyTotalRow>();

  return (results.results || []).map(row => ({
    hour: parseInt(row.hour, 10),
    gatewayId: row.gateway_id,
    totalHeat1: row.total_heat_1,
    totalHeat2: row.total_heat_2,
    totalCool1: row.total_cool_1,
    totalCool2: row.total_cool_2,
    totalElectricHeat: row.total_electric_heat,
    totalPower: row.total_power,
    readingCount: row.reading_count,
  }));
}

export interface HourlyTotal {
  hour: number;
  gatewayId: string;
  totalHeat1: number;
  totalHeat2: number;
  totalCool1: number;
  totalCool2: number;
  totalElectricHeat: number;
  totalPower: number;
  readingCount: number;
}

interface HourlyTotalRow {
  hour: string;
  gateway_id: string;
  total_heat_1: number;
  total_heat_2: number;
  total_cool_1: number;
  total_cool_2: number;
  total_electric_heat: number;
  total_power: number;
  reading_count: number;
}

/**
 * Get raw energy readings
 */
export async function getRawReadings(
  db: D1Database,
  startDate: string,
  endDate: string,
  gatewayId?: string,
  timezone: string = 'America/Los_Angeles'
): Promise<StoredEnergyReading[]> {
  const offsetMs = getTimezoneOffsetMs(timezone, startDate);
  const startTs = new Date(`${startDate}T00:00:00Z`).getTime() - offsetMs;
  const endTs = new Date(`${endDate}T23:59:59Z`).getTime() - offsetMs;

  let query = `
    SELECT * FROM energy_readings
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const params: (number | string)[] = [startTs, endTs];

  if (gatewayId) {
    query += ' AND gateway_id = ?';
    params.push(gatewayId);
  }

  query += ' ORDER BY timestamp DESC LIMIT 1000';

  const results = await db
    .prepare(query)
    .bind(...params)
    .all<RawReadingRow>();

  return (results.results || []).map(row => ({
    id: row.id,
    gateway_id: row.gateway_id,
    timestamp: row.timestamp,
    total_heat_1: row.total_heat_1,
    total_heat_2: row.total_heat_2,
    total_cool_1: row.total_cool_1,
    total_cool_2: row.total_cool_2,
    total_electric_heat: row.total_electric_heat,
    total_fan_only: row.total_fan_only,
    total_loop_pump: row.total_loop_pump,
    total_dehumidification: row.total_dehumidification,
    runtime_heat_1: row.runtime_heat_1,
    runtime_heat_2: row.runtime_heat_2,
    runtime_cool_1: row.runtime_cool_1,
    runtime_cool_2: row.runtime_cool_2,
    runtime_electric_heat: row.runtime_electric_heat,
    runtime_fan_only: row.runtime_fan_only,
    runtime_dehumidification: row.runtime_dehumidification,
    total_power: row.total_power,
  }));
}

interface RawReadingRow {
  id: number;
  gateway_id: string;
  timestamp: number;
  total_heat_1: number;
  total_heat_2: number;
  total_cool_1: number;
  total_cool_2: number;
  total_electric_heat: number;
  total_fan_only: number;
  total_loop_pump: number;
  total_dehumidification: number;
  runtime_heat_1: number;
  runtime_heat_2: number;
  runtime_cool_1: number;
  runtime_cool_2: number;
  runtime_electric_heat: number;
  runtime_fan_only: number;
  runtime_dehumidification: number;
  total_power: number;
}

/**
 * Get list of known gateway IDs from stored data
 */
export async function getKnownGateways(db: D1Database): Promise<string[]> {
  const results = await db
    .prepare('SELECT DISTINCT gateway_id FROM energy_readings ORDER BY gateway_id')
    .all<{ gateway_id: string }>();

  return (results.results || []).map(row => row.gateway_id);
}
