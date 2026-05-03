/**
 * Minimal ServiceNow Table API client.
 *
 * Docs: https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI
 */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function basicAuthHeader(user, password) {
  const token = Buffer.from(`${user}:${password}`).toString("base64");
  return `Basic ${token}`;
}

export function servicenowConfig() {
  const instance = requireEnv("SERVICENOW_INSTANCE");
  const user = requireEnv("SERVICENOW_USER");
  const password = requireEnv("SERVICENOW_PASSWORD");
  const baseUrl = `https://${instance}.service-now.com`;
  return { instance, user, password, baseUrl };
}

/**
 * Create an incident record on the configured ServiceNow instance.
 * @param {object} fields - record fields, e.g. { short_description, description, urgency }
 * @returns {Promise<{sys_id: string, number: string, link: string, raw: object}>}
 */
export async function createIncident(fields) {
  const { baseUrl, user, password } = servicenowConfig();
  const url = `${baseUrl}/api/now/table/incident`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(user, password),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const detail = body?.error?.message || body?.raw || res.statusText;
    throw new Error(`ServiceNow ${res.status}: ${detail}`);
  }

  const result = body?.result ?? {};
  const sysId = result.sys_id;
  const number = result.number;
  const link = sysId
    ? `${baseUrl}/nav_to.do?uri=incident.do?sys_id=${sysId}`
    : baseUrl;

  return { sys_id: sysId, number, link, raw: result };
}

/**
 * Update an existing incident record. Used by the remediation graph to
 * resolve / close the ticket once the fix has been verified and (optionally)
 * a PR has been opened.
 *
 * Common ServiceNow `state` values:
 *   "1" New, "2" In Progress, "3" On Hold, "6" Resolved, "7" Closed, "8" Canceled
 *
 * Resolving an incident requires both `close_code` and `close_notes`.
 *
 * @param {string} sysId   sys_id of the incident to update
 * @param {object} fields  e.g. { state, close_code, close_notes, work_notes }
 * @returns {Promise<{sys_id: string, number: string, state: string, raw: object}>}
 */
export async function updateIncident(sysId, fields) {
  if (!sysId) throw new Error("updateIncident: sysId is required");

  const { baseUrl, user, password } = servicenowConfig();
  const url = `${baseUrl}/api/now/table/incident/${encodeURIComponent(sysId)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: basicAuthHeader(user, password),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const detail = body?.error?.message || body?.raw || res.statusText;
    throw new Error(`ServiceNow ${res.status}: ${detail}`);
  }

  const result = body?.result ?? {};
  return {
    sys_id: result.sys_id ?? sysId,
    number: result.number,
    state: result.state,
    raw: result,
  };
}
