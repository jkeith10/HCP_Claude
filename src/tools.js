import { hcp, pickList } from './hcpClient.js';

/**
 * Tool definitions for the assistant.
 *
 * Each tool has:
 *   - schema:  the Anthropic tool definition (name/description/input_schema)
 *   - write:   true if the tool mutates the HCP account (gated behind confirm)
 *   - execute: (input) => result   the server-side implementation
 *   - describe:(input) => string   a human-readable summary for the confirm card
 *
 * Read tools run immediately. Write tools are NOT executed until the user
 * approves them in the UI (see assistant.js / server.js).
 */

const MAX_ITEMS = 25; // cap list payloads returned to the model to save tokens

function trimList(data, keyHint) {
  const { items, total } = pickList(data, keyHint);
  const trimmed = items.slice(0, MAX_ITEMS);
  return {
    total,
    returned: trimmed.length,
    truncated: total > trimmed.length,
    items: trimmed,
  };
}

// Best-effort predicates. HCP status vocab varies; treat generously.
function isUnpaid(inv) {
  const status = String(inv?.status ?? inv?.payment_status ?? '').toLowerCase();
  if (['paid', 'closed', 'refunded', 'voided'].includes(status)) return false;
  if (inv?.paid_at) return false;
  const outstanding = inv?.amount_due ?? inv?.balance ?? inv?.outstanding_balance;
  if (typeof outstanding === 'number') return outstanding > 0;
  return true; // when unsure, surface it rather than hide it
}

function isUnsigned(est) {
  const status = String(est?.status ?? '').toLowerCase();
  // Anything not yet approved/accepted/signed counts as "unsigned".
  const settled = ['approved', 'pro approved', 'pro_approved', 'accepted', 'signed', 'converted', 'declined'];
  if (est?.approved_at || est?.signed_at) return false;
  return !settled.includes(status);
}

export const tools = [
  // ---- READ ----------------------------------------------------------------
  {
    write: false,
    schema: {
      name: 'get_schedule',
      description:
        "List scheduled jobs (the schedule). Filter by a date range to see today's, this week's, or a specific day's appointments. Dates are ISO-8601 (e.g. 2026-07-01 or 2026-07-01T00:00:00Z).",
      input_schema: {
        type: 'object',
        properties: {
          scheduled_start_min: {
            type: 'string',
            description: 'Only jobs scheduled on/after this ISO datetime.',
          },
          scheduled_start_max: {
            type: 'string',
            description: 'Only jobs scheduled on/before this ISO datetime.',
          },
          page_size: { type: 'integer', description: 'Max results (default 25).' },
        },
      },
    },
    describe: (i) =>
      `View schedule${i.scheduled_start_min ? ` from ${i.scheduled_start_min}` : ''}${
        i.scheduled_start_max ? ` to ${i.scheduled_start_max}` : ''
      }`,
    execute: async (i) => {
      const data = await hcp.listJobs({
        scheduled_start_min: i.scheduled_start_min,
        scheduled_start_max: i.scheduled_start_max,
        page_size: i.page_size ?? MAX_ITEMS,
      });
      return trimList(data, 'jobs');
    },
  },
  {
    write: false,
    schema: {
      name: 'list_customers',
      description:
        'Search or list customers. Provide `q` to search by name, email, phone, or address.',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text search query.' },
          page_size: { type: 'integer', description: 'Max results (default 25).' },
        },
      },
    },
    describe: (i) => `Search customers${i.q ? ` for "${i.q}"` : ''}`,
    execute: async (i) => {
      const data = await hcp.listCustomers({ q: i.q, page_size: i.page_size ?? MAX_ITEMS });
      return trimList(data, 'customers');
    },
  },
  {
    write: false,
    schema: {
      name: 'get_customer',
      description: 'Get full details for one customer by their Housecall Pro customer id.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'HCP customer id.' },
        },
        required: ['customer_id'],
      },
    },
    describe: (i) => `Look up customer ${i.customer_id}`,
    execute: async (i) => hcp.getCustomer(i.customer_id),
  },
  {
    write: false,
    schema: {
      name: 'get_service_history',
      description:
        "Get a customer's service history: their past and upcoming jobs. Requires the HCP customer id (use list_customers first if you only have a name).",
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'HCP customer id.' },
          page_size: { type: 'integer', description: 'Max results (default 25).' },
        },
        required: ['customer_id'],
      },
    },
    describe: (i) => `View service history for customer ${i.customer_id}`,
    execute: async (i) => {
      const data = await hcp.getCustomerJobs(i.customer_id, {
        page_size: i.page_size ?? MAX_ITEMS,
      });
      return trimList(data, 'jobs');
    },
  },
  {
    write: false,
    schema: {
      name: 'list_unpaid_invoices',
      description:
        'List invoices that still have a balance owing (unpaid / partially paid).',
      input_schema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', description: 'Max results to scan (default 25).' },
        },
      },
    },
    describe: () => 'List unpaid invoices',
    execute: async (i) => {
      const data = await hcp.listInvoices({ page_size: i.page_size ?? 100 });
      const { items, total } = pickList(data, 'invoices');
      const unpaid = items.filter(isUnpaid).slice(0, MAX_ITEMS);
      return {
        scanned: items.length,
        total_reported: total,
        returned: unpaid.length,
        note: 'Filtered client-side to invoices that appear unpaid.',
        items: unpaid,
      };
    },
  },
  {
    write: false,
    schema: {
      name: 'list_unsigned_estimates',
      description:
        'List estimates that have not yet been approved/signed by the customer.',
      input_schema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', description: 'Max results to scan (default 25).' },
        },
      },
    },
    describe: () => 'List unsigned estimates',
    execute: async (i) => {
      const data = await hcp.listEstimates({ page_size: i.page_size ?? 100 });
      const { items, total } = pickList(data, 'estimates');
      const unsigned = items.filter(isUnsigned).slice(0, MAX_ITEMS);
      return {
        scanned: items.length,
        total_reported: total,
        returned: unsigned.length,
        note: 'Filtered client-side to estimates that appear unsigned/unapproved.',
        items: unsigned,
      };
    },
  },

  // ---- WRITE (confirm-gated) ----------------------------------------------
  {
    write: true,
    schema: {
      name: 'create_job',
      description:
        'Create a new job for a customer. Requires confirmation before it runs. Provide the HCP customer id and job details.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'HCP customer id.' },
          scheduled_start: { type: 'string', description: 'ISO-8601 start datetime.' },
          scheduled_end: { type: 'string', description: 'ISO-8601 end datetime.' },
          description: { type: 'string', description: 'Job description / work to be done.' },
          line_items: {
            type: 'array',
            description: 'Optional line items.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit_price: { type: 'number', description: 'Unit price in cents or dollars per your account.' },
              },
            },
          },
        },
        required: ['customer_id'],
      },
    },
    describe: (i) =>
      `Create a job for customer ${i.customer_id}${
        i.scheduled_start ? ` starting ${i.scheduled_start}` : ''
      }${i.description ? ` — "${i.description}"` : ''}`,
    execute: async (i) => hcp.createJob(i),
  },
  {
    write: true,
    schema: {
      name: 'update_job',
      description:
        'Update an existing job (reschedule, change description, etc). Requires confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'HCP job id to update.' },
          scheduled_start: { type: 'string', description: 'New ISO-8601 start datetime.' },
          scheduled_end: { type: 'string', description: 'New ISO-8601 end datetime.' },
          description: { type: 'string', description: 'New job description.' },
          work_status: { type: 'string', description: 'e.g. scheduled, in_progress, completed.' },
        },
        required: ['job_id'],
      },
    },
    describe: (i) => {
      const changes = Object.entries(i)
        .filter(([k]) => k !== 'job_id')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      return `Update job ${i.job_id}${changes ? ` (${changes})` : ''}`;
    },
    execute: async ({ job_id, ...body }) => hcp.updateJob(job_id, body),
  },
  {
    write: true,
    schema: {
      name: 'create_estimate',
      description:
        'Create a new estimate for a customer. Requires confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'HCP customer id.' },
          description: { type: 'string', description: 'Estimate summary / scope.' },
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit_price: { type: 'number' },
              },
            },
          },
        },
        required: ['customer_id'],
      },
    },
    describe: (i) =>
      `Create an estimate for customer ${i.customer_id}${
        i.description ? ` — "${i.description}"` : ''
      }`,
    execute: async (i) => hcp.createEstimate(i),
  },
  {
    write: true,
    schema: {
      name: 'update_estimate',
      description: 'Update an existing estimate. Requires confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          estimate_id: { type: 'string', description: 'HCP estimate id to update.' },
          description: { type: 'string', description: 'New description.' },
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit_price: { type: 'number' },
              },
            },
          },
        },
        required: ['estimate_id'],
      },
    },
    describe: (i) => `Update estimate ${i.estimate_id}`,
    execute: async ({ estimate_id, ...body }) => hcp.updateEstimate(estimate_id, body),
  },
];

export const toolsByName = Object.fromEntries(tools.map((t) => [t.schema.name, t]));

// Anthropic tool definitions only (schemas).
export const toolSchemas = tools.map((t) => t.schema);
