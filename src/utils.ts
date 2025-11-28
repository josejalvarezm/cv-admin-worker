/**
 * Utility functions for cv-admin-worker
 */

/**
 * Generate stable_id from technology name
 * Used to link D1CV and cv-ai-agent records
 */
export function generateStableId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#.]/g, '')           // Remove C#, .NET dots
    .replace(/[^a-z0-9]+/g, '-')    // Replace non-alphanumeric with dash
    .replace(/^-|-$/g, '');          // Trim dashes
}

/**
 * Sanitize string input to prevent XSS
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim();
}

/**
 * Create CORS headers for responses
 */
export function corsHeaders(origin: string = 'https://admin.{YOUR_DOMAIN}'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-JWT-Assertion',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Create JSON response with CORS headers
 */
export function jsonResponse<T>(data: T, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

/**
 * Create error response
 */
export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message, success: false }, status);
}

/**
 * Validate that entity_id is provided for UPDATE/DELETE operations
 */
export function validateEntityId(operation: string, entityId: number | null | undefined): boolean {
  if (operation === 'INSERT') return true;
  return entityId !== null && entityId !== undefined;
}
