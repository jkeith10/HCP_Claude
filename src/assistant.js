import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { toolsByName, toolSchemas } from './tools.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a hands-on assistant for an HVAC contractor, connected to their Housecall Pro account. You help them run their day from their phone: checking the schedule, looking up customers and service history, chasing unpaid invoices and unsigned estimates, and — when asked — creating or updating jobs and estimates.

Guidelines:
- Be concise and practical. This person is often in the field, on a phone, possibly using voice. Lead with the answer.
- When you need a customer's HCP id but only have a name, call list_customers first, then the specific tool.
- Read tools run immediately. Write tools (create/update job or estimate) are gated: the app shows the user a confirmation card before anything changes. Propose the write with clear, specific inputs; the user approves or cancels.
- Prefer to do one write at a time so each is easy to confirm.
- Never invent job ids, customer ids, invoice numbers, or dollar amounts. If you don't have a value, look it up or ask.
- Today's date and the user's timezone context may matter for "today" / "this week" — if a date range is ambiguous, state the range you're using.
- If a tool returns an error, explain it plainly and suggest the fix; don't silently retry destructive actions.`;

const MODEL = config.anthropicModel;

function textFrom(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toolResult(toolUseId, output, isError = false) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof output === 'string' ? output : JSON.stringify(output),
    is_error: isError,
  };
}

async function runExecute(toolUse) {
  const def = toolsByName[toolUse.name];
  if (!def) return toolResult(toolUse.id, `Unknown tool: ${toolUse.name}`, true);
  try {
    const out = await def.execute(toolUse.input ?? {});
    return toolResult(toolUse.id, out);
  } catch (err) {
    return toolResult(toolUse.id, { error: err.message }, true);
  }
}

/**
 * Drive the Claude tool-use loop for a session until either:
 *   - the model produces a final text answer  -> { type: 'message', text }
 *   - the model requests a write (mutation)     -> { type: 'confirm', actions, pending }
 *
 * Read tool_use blocks execute immediately. If any write tool_use blocks are
 * present, their execution is deferred: the read results are held, and the
 * write proposals are returned for user confirmation. On confirm/cancel (see
 * resumeAfterConfirmation) the loop continues.
 */
export async function runAssistant(session) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages: session.messages,
    });

    session.messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { type: 'message', text: "I can't help with that request." };
    }

    if (response.stop_reason !== 'tool_use') {
      return { type: 'message', text: textFrom(response.content) };
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const readResults = [];
    const writes = [];

    for (const tu of toolUses) {
      const def = toolsByName[tu.name];
      if (def?.write) {
        writes.push(tu);
      } else {
        readResults.push(await runExecute(tu));
      }
    }

    if (writes.length > 0) {
      // Pause for confirmation. Hold read results so all tool_results can be
      // returned together in one user turn once the user decides.
      session.pending = { readResults, writes };
      return {
        type: 'confirm',
        preamble: textFrom(response.content),
        actions: writes.map((tu) => ({
          id: tu.id,
          tool: tu.name,
          summary: toolsByName[tu.name].describe(tu.input ?? {}),
          input: tu.input ?? {},
        })),
      };
    }

    // Only reads: feed results back and continue.
    session.messages.push({ role: 'user', content: readResults });
  }
}

/**
 * Resume the loop after the user approves or cancels the pending writes.
 */
export async function resumeAfterConfirmation(session, approved) {
  const pending = session.pending;
  session.pending = null;
  if (!pending) {
    return { type: 'message', text: 'Nothing was awaiting confirmation.' };
  }

  const results = [...pending.readResults];
  for (const tu of pending.writes) {
    if (approved) {
      results.push(await runExecute(tu));
    } else {
      results.push(
        toolResult(
          tu.id,
          'The user declined this action. It was NOT performed. Do not retry it unless the user explicitly asks again.',
        ),
      );
    }
  }

  session.messages.push({ role: 'user', content: results });
  return runAssistant(session);
}
