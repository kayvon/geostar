import type { Session } from './auth';

const BASE_URL = 'https://symphony.mygeostar.com';

export interface Gateway {
  gwid: string;
  name: string;
  location?: string;
}

export interface EnergyReading {
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

interface EnergyApiResponse {
  columns: string[];
  index: number[];
  data: number[][];
}

interface LocationData {
  gateways?: Array<{
    gwid: string;
    description?: string;
    location?: string;
  }>;
}

/**
 * Build cookie string for authenticated requests
 */
function buildCookies(session: Session): string {
  return `sessionid=${session.sessionId}; Symphony=${session.sessionId}; auk=${session.userKey}`;
}

/**
 * Get all gateways for the user
 */
export async function getGateways(session: Session): Promise<Gateway[]> {
  console.log(`[geostar] Fetching gateways for user ${session.userKey}`);

  const response = await fetch(
    `${BASE_URL}/api.php/awl/json/location/getlocationdata.php`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': buildCookies(session),
      },
      body: `awluserkey=${session.userKey}`,
    }
  );

  console.log(`[geostar] Location API response status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    console.log(`[geostar] Location API error: ${text.substring(0, 500)}`);
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Session expired');
    }
    throw new Error(`Failed to get location data: ${response.status}`);
  }

  const text = await response.text();
  console.log(`[geostar] Location API response: ${text.substring(0, 1000)}`);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse location data as JSON: ${text.substring(0, 200)}`);
  }

  console.log(`[geostar] Location data keys: ${Object.keys(data).join(', ')}`);

  // Check for gateways array
  if (data.gateways && Array.isArray(data.gateways)) {
    console.log(`[geostar] Found gateways array with ${(data.gateways as unknown[]).length} items`);
    return (data.gateways as Array<{ gwid: string; description?: string; location?: string }>).map((gw) => ({
      gwid: gw.gwid,
      name: gw.description || gw.gwid,
      location: gw.location,
    }));
  }

  // Try alternative parsing - look for nested objects with gwid
  const gateways: Gateway[] = [];

  function findGateways(obj: unknown, path: string = ''): void {
    if (typeof obj !== 'object' || obj === null) return;

    if ('gwid' in obj && typeof (obj as Record<string, unknown>).gwid === 'string') {
      const gw = obj as { gwid: string; description?: string; location?: string; name?: string };
      console.log(`[geostar] Found gateway at ${path}: ${gw.gwid}`);
      gateways.push({
        gwid: gw.gwid,
        name: gw.description || gw.name || gw.gwid,
        location: gw.location,
      });
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        findGateways(value, `${path}.${key}`);
      }
    }
  }

  findGateways(data, 'root');

  if (gateways.length > 0) {
    console.log(`[geostar] Found ${gateways.length} gateways via deep search`);
    return gateways;
  }

  throw new Error(`No gateways found in location data. Keys: ${Object.keys(data).join(', ')}`);
}

/**
 * Get energy data for a specific gateway
 */
export async function getEnergyData(
  session: Session,
  gwid: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  freq: '15min' | '1H' | '1D' | '7D' | '1M' = '15min',
  timezone: string = 'America/Los_Angeles'
): Promise<EnergyReading[]> {
  const params = new URLSearchParams({
    awluserkey: session.userKey,
    freq,
    start: startDate,
    end: endDate,
    timezone,
  });

  const url = `${BASE_URL}/api.php/v2/gateway/${gwid}/energy?${params}`;
  console.log(`[geostar] Fetching energy data: ${url}`);

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Cookie': buildCookies(session),
    },
  });

  console.log(`[geostar] Energy API response status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    console.log(`[geostar] Energy API error: ${text.substring(0, 500)}`);
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Session expired');
    }
    throw new Error(`Failed to get energy data: ${response.status}`);
  }

  const text = await response.text();
  console.log(`[geostar] Energy API response (first 500 chars): ${text.substring(0, 500)}`);

  let data: EnergyApiResponse;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse energy data as JSON: ${text.substring(0, 200)}`);
  }

  console.log(`[geostar] Energy data keys: ${Object.keys(data).join(', ')}`);
  console.log(`[geostar] columns: ${data.columns?.length ?? 'undefined'}, index: ${data.index?.length ?? 'undefined'}, data: ${data.data?.length ?? 'undefined'}`);

  return parseEnergyResponse(data);
}

/**
 * Parse the columnar energy API response into typed readings
 */
function parseEnergyResponse(data: EnergyApiResponse): EnergyReading[] {
  const { columns, index, data: rows } = data;

  // Handle missing or empty data
  if (!columns || !Array.isArray(columns)) {
    console.log('[geostar] No columns in energy response');
    return [];
  }
  if (!index || !Array.isArray(index)) {
    console.log('[geostar] No index in energy response');
    return [];
  }
  if (!rows || !Array.isArray(rows)) {
    console.log('[geostar] No data rows in energy response');
    return [];
  }

  console.log(`[geostar] Parsing ${index.length} energy readings with ${columns.length} columns`);

  // Create a map of column names to indices
  const colIndex = new Map<string, number>();
  columns.forEach((col, i) => colIndex.set(col, i));

  const getVal = (row: number[], colName: string): number => {
    const idx = colIndex.get(colName);
    return idx !== undefined ? (row[idx] ?? 0) : 0;
  };

  return index.map((timestamp, i) => {
    const row = rows[i] || [];
    return {
      timestamp,
      total_heat_1: getVal(row, 'total_heat_1'),
      total_heat_2: getVal(row, 'total_heat_2'),
      total_cool_1: getVal(row, 'total_cool_1'),
      total_cool_2: getVal(row, 'total_cool_2'),
      total_electric_heat: getVal(row, 'total_electric_heat'),
      total_fan_only: getVal(row, 'total_fan_only'),
      total_loop_pump: getVal(row, 'total_loop_pump'),
      total_dehumidification: getVal(row, 'total_dehumidification'),
      runtime_heat_1: getVal(row, 'runtime_heat_1'),
      runtime_heat_2: getVal(row, 'runtime_heat_2'),
      runtime_cool_1: getVal(row, 'runtime_cool_1'),
      runtime_cool_2: getVal(row, 'runtime_cool_2'),
      runtime_electric_heat: getVal(row, 'runtime_electric_heat'),
      runtime_fan_only: getVal(row, 'runtime_fan_only'),
      runtime_dehumidification: getVal(row, 'runtime_dehumidification'),
      total_power: getVal(row, 'total_power'),
    };
  });
}

/**
 * Custom error class for authentication failures
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
