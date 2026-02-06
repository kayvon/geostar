import type { D1Database } from '@cloudflare/workers-types';

const BASE_URL = 'https://symphony.mygeostar.com';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface Session {
  sessionId: string;
  userKey: string;
  createdAt: number;
}

export interface AuthResult {
  session: Session;
  fresh: boolean;
}

/**
 * Login to GeoStar and return session credentials
 */
export async function login(email: string, password: string): Promise<Session> {
  console.log(`[auth] Attempting login for ${email}`);

  const body = new URLSearchParams({
    op: 'login',
    redirect: '/',
    emailaddress: email,
    password: password,
  });

  const response = await fetch(`${BASE_URL}/account/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: body.toString(),
    redirect: 'manual', // Don't follow redirect, we need the Set-Cookie header
  });

  console.log(`[auth] Login response status: ${response.status}`);

  if (response.status !== 302) {
    const text = await response.text();
    console.log(`[auth] Login failed response body: ${text.substring(0, 500)}`);
    throw new Error(`Login failed: expected 302, got ${response.status}`);
  }

  // Extract sessionid from Set-Cookie header
  const setCookie = response.headers.get('Set-Cookie');
  console.log(`[auth] Set-Cookie header: ${setCookie}`);

  if (!setCookie) {
    throw new Error('Login failed: no Set-Cookie header');
  }

  const sessionMatch = setCookie.match(/sessionid=([^;]+)/);
  if (!sessionMatch) {
    throw new Error(`Login failed: no sessionid in Set-Cookie. Header was: ${setCookie}`);
  }

  const sessionId = sessionMatch[1];
  console.log(`[auth] Got session ID: ${sessionId.substring(0, 8)}...`);

  // Get user key from /api.php/user
  const userKey = await getUserKey(sessionId);
  console.log(`[auth] Got user key: ${userKey}`);

  return {
    sessionId,
    userKey,
    createdAt: Date.now(),
  };
}

/**
 * Fetch user key from GeoStar API
 */
async function getUserKey(sessionId: string): Promise<string> {
  console.log(`[auth] Fetching user info with session ${sessionId.substring(0, 8)}...`);

  const response = await fetch(`${BASE_URL}/api.php/user`, {
    headers: {
      'Accept': 'application/json',
      'Cookie': `sessionid=${sessionId}; Symphony=${sessionId}`,
    },
  });

  console.log(`[auth] User API response status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    console.log(`[auth] User API error response: ${text.substring(0, 500)}`);
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  const text = await response.text();
  console.log(`[auth] User API response body: ${text.substring(0, 500)}`);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse user API response as JSON: ${text.substring(0, 200)}`);
  }

  // Try multiple possible field names for the user key
  const userKey = data.awlUserKey || data.awluserkey || data.auk || data.id || data.user_id || data.userId;

  if (!userKey) {
    throw new Error(`Failed to get user key from user data. Available fields: ${Object.keys(data).join(', ')}`);
  }

  return String(userKey);
}

/**
 * Get stored session from D1
 */
export async function getStoredSession(db: D1Database): Promise<Session | null> {
  const result = await db
    .prepare('SELECT session_id, user_key, created_at FROM sessions WHERE id = 1')
    .first<{ session_id: string; user_key: string; created_at: number }>();

  if (!result) {
    return null;
  }

  return {
    sessionId: result.session_id,
    userKey: result.user_key,
    createdAt: result.created_at,
  };
}

/**
 * Store session in D1
 */
export async function storeSession(db: D1Database, session: Session): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO sessions (id, session_id, user_key, created_at)
       VALUES (1, ?, ?, ?)`
    )
    .bind(session.sessionId, session.userKey, session.createdAt)
    .run();
}

/**
 * Check if session is expired (older than 12 hours)
 */
function isSessionExpired(session: Session): boolean {
  return Date.now() - session.createdAt > SESSION_MAX_AGE_MS;
}

/**
 * Validate session by making a test API call.
 * GeoStar returns 200 even for expired sessions, so we must check
 * the response body for actual user data, not just HTTP status.
 */
export async function validateSession(session: Session): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api.php/user`, {
      headers: {
        'Accept': 'application/json',
        'Cookie': `sessionid=${session.sessionId}; Symphony=${session.sessionId}; auk=${session.userKey}`,
      },
    });
    if (!response.ok) return false;

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      console.log(`[auth] Validation failed: response not JSON`);
      return false;
    }

    // Check for error indicators in the response body
    if (data.err && data.err !== '') {
      console.log(`[auth] Validation failed: API returned err: ${data.err}`);
      return false;
    }

    // Verify we actually got user data back
    const hasUserKey = !!(data.awlUserKey || data.awluserkey || data.auk || data.id || data.user_id || data.userId);
    if (!hasUserKey) {
      console.log(`[auth] Validation failed: no user key in response. Keys: ${Object.keys(data).join(', ')}`);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get a valid session, re-logging in if necessary
 */
export async function getValidSession(
  db: D1Database,
  email: string,
  password: string
): Promise<AuthResult> {
  console.log('[auth] Getting valid session...');

  // Try to get stored session
  const storedSession = await getStoredSession(db);

  if (storedSession) {
    console.log(`[auth] Found stored session, created at ${new Date(storedSession.createdAt).toISOString()}`);

    if (!isSessionExpired(storedSession)) {
      // Validate the session is still working
      console.log('[auth] Session not expired, validating...');
      const isValid = await validateSession(storedSession);
      if (isValid) {
        console.log('[auth] Stored session is valid');
        return { session: storedSession, fresh: false };
      }
      console.log('[auth] Stored session failed validation');
    } else {
      console.log('[auth] Stored session is expired');
    }
  } else {
    console.log('[auth] No stored session found');
  }

  // Need to login
  console.log('[auth] Performing fresh login...');
  const newSession = await login(email, password);
  await storeSession(db, newSession);
  console.log('[auth] New session stored');

  return { session: newSession, fresh: true };
}
