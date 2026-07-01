import { config } from './config.js';

/**
 * Thin wrapper around the Housecall Pro REST API.
 *
 * Auth: API-key mode uses `Authorization: Token <key>` (per the HCP API docs /
 * help center). The key lives ONLY in process.env on the server and is never
 * sent to the browser.
 *
 * Note on schemas: HCP's list endpoints and field names can vary by account /
 * API version. Response shapes are normalized defensively in `pickList()` and
 * the summarizers below. If a field name is off for your account, adjust the
 * helpers here — the rest of the app reads through these methods.
 */
class HousecallProClient {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const detail =
        (data && (data.message || data.error || data.errors)) || res.statusText;
      const err = new Error(
        `Housecall Pro API ${method} ${path} failed (${res.status}): ${
          typeof detail === 'string' ? detail : JSON.stringify(detail)
        }`,
      );
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // --- Reads ---------------------------------------------------------------

  listJobs(query) {
    return this.request('GET', '/jobs', { query });
  }

  listCustomers(query) {
    return this.request('GET', '/customers', { query });
  }

  getCustomer(customerId) {
    return this.request('GET', `/customers/${encodeURIComponent(customerId)}`);
  }

  getCustomerJobs(customerId, query) {
    return this.request('GET', `/customers/${encodeURIComponent(customerId)}/jobs`, {
      query,
    });
  }

  listInvoices(query) {
    return this.request('GET', '/invoices', { query });
  }

  listEstimates(query) {
    return this.request('GET', '/estimates', { query });
  }

  // --- Writes --------------------------------------------------------------

  createJob(body) {
    return this.request('POST', '/jobs', { body });
  }

  updateJob(jobId, body) {
    return this.request('PUT', `/jobs/${encodeURIComponent(jobId)}`, { body });
  }

  createEstimate(body) {
    return this.request('POST', '/estimates', { body });
  }

  updateEstimate(estimateId, body) {
    return this.request('PUT', `/estimates/${encodeURIComponent(estimateId)}`, {
      body,
    });
  }
}

/**
 * HCP list responses come back in a few shapes depending on endpoint/version:
 *   - a bare array
 *   - { data: [...] }
 *   - { jobs: [...] } / { customers: [...] } / etc.
 * Return { items, total } regardless.
 */
export function pickList(data, keyHint) {
  if (Array.isArray(data)) return { items: data, total: data.length };
  if (data && typeof data === 'object') {
    const candidateKeys = [keyHint, 'data', 'jobs', 'customers', 'invoices', 'estimates'];
    for (const key of candidateKeys) {
      if (key && Array.isArray(data[key])) {
        const total =
          data.total_items ?? data.total ?? data.count ?? data[key].length;
        return { items: data[key], total };
      }
    }
  }
  return { items: [], total: 0 };
}

export const hcp = new HousecallProClient({
  apiKey: config.housecallApiKey,
  baseUrl: config.housecallApiBase,
});
