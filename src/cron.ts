import type { D1Database } from '@cloudflare/workers-types';
import { getValidSession, login, storeSession } from './auth';
import { getGateways, getEnergyData, AuthError } from './geostar-client';
import { insertEnergyReadings, getTimezoneOffsetMs } from './db';

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
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  const today = formatter.format(now);
  const yesterday = formatter.format(new Date(now.getTime() - 24 * 60 * 60 * 1000));

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
          // Split readings at midnight-today: yesterday's are final (ignore dupes),
          // today's may be incomplete and should overwrite stale values
          const offsetMs = getTimezoneOffsetMs(timezone, end);
          const midnightToday = new Date(`${end}T00:00:00Z`).getTime() - offsetMs;

          const yesterdayReadings = readings.filter(r => r.timestamp < midnightToday);
          const todayReadings = readings.filter(r => r.timestamp >= midnightToday);

          console.log(`Gateway ${gateway.gwid}: ${yesterdayReadings.length} yesterday, ${todayReadings.length} today`);

          const yesterdayResult = await insertEnergyReadings(db, gateway.gwid, yesterdayReadings, false);
          const todayResult = await insertEnergyReadings(db, gateway.gwid, todayReadings, true);

          gwResult.inserted = yesterdayResult.inserted + todayResult.inserted;
          gwResult.skipped = yesterdayResult.skipped + todayResult.skipped;
          console.log(`Inserted ${gwResult.inserted}, skipped ${gwResult.skipped} for gateway ${gateway.gwid}`);
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
  timezone: string = 'America/Los_Angeles',
  override: boolean = false
): Promise<CronResult> {
  const result: CronResult = {
    success: true,
    gateways: [],
    loginRefreshed: false,
  };

  try {
    // Get a valid session
    const authResult = await getValidSession(db, email, password);
    let session = authResult.session;
    result.loginRefreshed = authResult.fresh;

    // Get all gateways
    let gateways;
    try {
      gateways = await getGateways(session);
    } catch (error) {
      // If auth error, try re-login once
      if (error instanceof AuthError) {
        console.log('[backfill] Session invalid, re-logging in...');
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
          const insertResult = await insertEnergyReadings(db, gateway.gwid, readings, override);
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
