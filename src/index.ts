import type { D1Database, ScheduledController, ExecutionContext } from '@cloudflare/workers-types';
import { runDailyFetch, backfillData } from './cron';
import { getDailyTotals, getHourlyTotals, getRawReadings, getKnownGateways } from './db';

export interface Env {
  DB: D1Database;
  GEOSTAR_EMAIL: string;
  GEOSTAR_PASSWORD: string;
  TIMEZONE: string;
}

// CORS headers for API responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // API routes
  if (path.startsWith('/api/')) {
    return handleApiRoute(path, url.searchParams, env);
  }

  // Manual cron trigger (for testing)
  if (path === '/__scheduled' || path === '/cron') {
    return handleManualCron(env);
  }

  // Backfill endpoint
  if (path === '/backfill') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end) {
      return errorResponse('Missing start or end parameter (YYYY-MM-DD)', 400);
    }
    return handleBackfill(env, start, end);
  }

  // Root - simple status page
  if (path === '/') {
    return jsonResponse({
      name: 'GeoStar Energy Dashboard',
      endpoints: {
        '/api/energy/daily': 'GET - Daily totals (params: start, end)',
        '/api/energy/hourly': 'GET - Hourly breakdown (params: date)',
        '/api/energy/raw': 'GET - Raw 15-min data (params: start, end, gateway?)',
        '/api/gateways': 'GET - List known gateways',
        '/cron': 'GET - Manually trigger daily fetch',
        '/backfill': 'GET - Backfill data (params: start, end)',
      },
    });
  }

  return errorResponse('Not found', 404);
}

async function handleApiRoute(path: string, params: URLSearchParams, env: Env): Promise<Response> {
  const { DB } = env;

  // GET /api/energy/daily?start=YYYY-MM-DD&end=YYYY-MM-DD
  if (path === '/api/energy/daily') {
    const start = params.get('start');
    const end = params.get('end');

    if (!start || !end) {
      return errorResponse('Missing start or end parameter', 400);
    }

    try {
      const data = await getDailyTotals(DB, start, end);
      return jsonResponse({ data });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Database error');
    }
  }

  // GET /api/energy/hourly?date=YYYY-MM-DD
  if (path === '/api/energy/hourly') {
    const date = params.get('date');

    if (!date) {
      return errorResponse('Missing date parameter', 400);
    }

    try {
      const data = await getHourlyTotals(DB, date);
      return jsonResponse({ data });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Database error');
    }
  }

  // GET /api/energy/raw?start=YYYY-MM-DD&end=YYYY-MM-DD&gateway=GWID
  if (path === '/api/energy/raw') {
    const start = params.get('start');
    const end = params.get('end');
    const gateway = params.get('gateway') || undefined;

    if (!start || !end) {
      return errorResponse('Missing start or end parameter', 400);
    }

    try {
      const data = await getRawReadings(DB, start, end, gateway);
      return jsonResponse({ data, count: data.length });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Database error');
    }
  }

  // GET /api/gateways
  if (path === '/api/gateways') {
    try {
      const gateways = await getKnownGateways(DB);
      return jsonResponse({ gateways });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Database error');
    }
  }

  return errorResponse('API endpoint not found', 404);
}

async function handleManualCron(env: Env): Promise<Response> {
  const { DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, TIMEZONE } = env;

  console.log('[handler] Manual cron triggered');

  if (!GEOSTAR_EMAIL || !GEOSTAR_PASSWORD) {
    console.log('[handler] Missing credentials');
    return errorResponse('Missing GEOSTAR_EMAIL or GEOSTAR_PASSWORD secrets', 500);
  }

  console.log(`[handler] Email: ${GEOSTAR_EMAIL}, Password: ${GEOSTAR_PASSWORD ? '[set]' : '[not set]'}`);

  try {
    const result = await runDailyFetch(DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, TIMEZONE || 'America/Los_Angeles');
    console.log(`[handler] Cron result: ${JSON.stringify(result)}`);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cron error';
    const stack = error instanceof Error ? error.stack : '';
    console.log(`[handler] Cron error: ${message}\n${stack}`);
    return errorResponse(message);
  }
}

async function handleBackfill(env: Env, start: string, end: string): Promise<Response> {
  const { DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, TIMEZONE } = env;

  if (!GEOSTAR_EMAIL || !GEOSTAR_PASSWORD) {
    return errorResponse('Missing GEOSTAR_EMAIL or GEOSTAR_PASSWORD secrets', 500);
  }

  try {
    const result = await backfillData(DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, start, end, TIMEZONE || 'America/Los_Angeles');
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Backfill error');
  }
}

// Scheduled cron handler
async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const { DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, TIMEZONE } = env;

  if (!GEOSTAR_EMAIL || !GEOSTAR_PASSWORD) {
    console.error('Missing GEOSTAR_EMAIL or GEOSTAR_PASSWORD secrets');
    return;
  }

  try {
    const result = await runDailyFetch(DB, GEOSTAR_EMAIL, GEOSTAR_PASSWORD, TIMEZONE || 'America/Los_Angeles');
    console.log('Cron result:', JSON.stringify(result));
  } catch (error) {
    console.error('Cron error:', error);
  }
}

export default {
  fetch: handleRequest,
  scheduled: handleScheduled,
};
