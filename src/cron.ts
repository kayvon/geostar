import type { D1Database } from '@cloudflare/workers-types';
import { getValidSession, login, storeSession } from './auth';
import { getGateways, getEnergyData, AuthError } from './geostar-client';
import { insertEnergyReadings } from './db';

export interface CronResult {
  success: boolean;
  gateways: GatewayResult[];
  error?: string;
  loginRefreshed: boolean;
}

export interface GatewayResult {
  gwid: string;
  inserted: number;
  skipped: number;
  error?: string;
}

/**
 * Get date range for yesterday (start=yesterday, end=today)
 * API requires start and end to be different
 */
function getYesterdayDateRange(timezone: string): { start: string; end: string } {
  const now = new Date();
  // Adjust for timezone (rough approximation - PT is UTC-8)
  const utcOffset = timezone === 'America/Los_Angeles' ? -8 : 0;
  const local = new Date(now.getTime() + utcOffset * 60 * 60 * 1000);

  const today = local.toISOString().split('T')[0];
  local.setDate(local.getDate() - 1);
  const yesterday = local.toISOString().split('T')[0];

  return { start: yesterday, end: today };
}

/**
 * Fetch energy data for all gateways for the previous day
 */
export async function runDailyFetch(
  db: D1Database,
  email: string,
  password: string,
  timezone: string = 'America/Los_Angeles'
): Promise<CronResult> {
  console.log('[cron] Starting daily fetch...');

  const result: CronResult = {
    success: true,
    gateways: [],
    loginRefreshed: false,
  };

  try {
    // Get a valid session
    console.log('[cron] Getting valid session...');
    const authResult = await getValidSession(db, email, password);
    let session = authResult.session;
    result.loginRefreshed = authResult.fresh;
    console.log(`[cron] Session obtained (fresh: ${authResult.fresh})`)

    // Get all gateways
    let gateways;
    try {
      gateways = await getGateways(session);
    } catch (error) {
      // If auth error, try re-login once
      if (error instanceof AuthError) {
        console.log('Session invalid, re-logging in...');
        session = await login(email, password);
        await storeSession(db, session);
        result.loginRefreshed = true;
        gateways = await getGateways(session);
      } else {
        throw error;
      }
    }

    if (gateways.length === 0) {
      result.error = 'No gateways found';
      result.success = false;
      return result;
    }

    console.log(`Found ${gateways.length} gateways: ${gateways.map(g => g.gwid).join(', ')}`);

    // Calculate date range for yesterday
    const { start, end } = getYesterdayDateRange(timezone);
    console.log(`[cron] Fetching data for date range: ${start} to ${end}`);

    // Fetch data for each gateway
    for (const gateway of gateways) {
      const gwResult: GatewayResult = {
        gwid: gateway.gwid,
        inserted: 0,
        skipped: 0,
      };

      try {
        console.log(`Fetching energy data for gateway ${gateway.gwid}...`);

        const readings = await getEnergyData(
          session,
          gateway.gwid,
          start,
          end,
          '15min',  // 15-minute granularity
          timezone
        );

        console.log(`Got ${readings.length} readings for gateway ${gateway.gwid}`);

        if (readings.length > 0) {
          const insertResult = await insertEnergyReadings(db, gateway.gwid, readings);
          gwResult.inserted = insertResult.inserted;
          gwResult.skipped = insertResult.skipped;
          console.log(`Inserted ${insertResult.inserted}, skipped ${insertResult.skipped} for gateway ${gateway.gwid}`);
        }
      } catch (error) {
        gwResult.error = error instanceof Error ? error.message : 'Unknown error';
        result.success = false;
      }

      result.gateways.push(gwResult);
    }
  } catch (error) {
    result.success = false;
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

/**
 * Backfill energy data for a date range
 */
export async function backfillData(
  db: D1Database,
  email: string,
  password: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  timezone: string = 'America/Los_Angeles'
): Promise<CronResult> {
  const result: CronResult = {
    success: true,
    gateways: [],
    loginRefreshed: false,
  };

  try {
    // Get a valid session
    const authResult = await getValidSession(db, email, password);
    const session = authResult.session;
    result.loginRefreshed = authResult.fresh;

    // Get all gateways
    const gateways = await getGateways(session);

    if (gateways.length === 0) {
      result.error = 'No gateways found';
      result.success = false;
      return result;
    }

    console.log(`Found ${gateways.length} gateways: ${gateways.map(g => g.gwid).join(', ')}`);

    // Fetch data for each gateway
    for (const gateway of gateways) {
      const gwResult: GatewayResult = {
        gwid: gateway.gwid,
        inserted: 0,
        skipped: 0,
      };

      try {
        console.log(`Backfilling energy data for gateway ${gateway.gwid} from ${startDate} to ${endDate}...`);

        const readings = await getEnergyData(
          session,
          gateway.gwid,
          startDate,
          endDate,
          '15min',
          timezone
        );

        console.log(`Got ${readings.length} readings for gateway ${gateway.gwid}`);

        if (readings.length > 0) {
          const insertResult = await insertEnergyReadings(db, gateway.gwid, readings);
          gwResult.inserted = insertResult.inserted;
          gwResult.skipped = insertResult.skipped;
          console.log(`Inserted ${insertResult.inserted}, skipped ${insertResult.skipped} for gateway ${gateway.gwid}`);
        }
      } catch (error) {
        gwResult.error = error instanceof Error ? error.message : 'Unknown error';
        result.success = false;
      }

      result.gateways.push(gwResult);
    }
  } catch (error) {
    result.success = false;
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}
