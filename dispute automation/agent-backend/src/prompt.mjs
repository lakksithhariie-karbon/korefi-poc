import { UNRESOLVED_STORE } from './constants.mjs';

/** The text sent to the agent for one turn. Exported so tests can check what the model is and is not told. */
export function buildPrompt(request) {
  const first = request.conversation.length === 0;
  const lines = [
    'Order ' + request.orderId + ' at store ' + (request.storeId === UNRESOLVED_STORE ? 'unknown (no store ID was found)' : request.storeId) + '.',
    first
      ? 'This is the first turn. Use the read-only tools for order financials, error charges, issue reports, historical patterns and prior cases.'
      : 'This is a follow-up turn. Use the conversation below. Call tools only if you need facts you do not have.',
    'Reported issue: ' + (request.issueCategory || 'unknown') + '; description: ' + (request.issueDescription || 'none'),
    'Charge: ' + (request.amount ?? 'unknown') + ' USD.',
    'Operator question: ' + (request.operatorQuestion || 'Provide an initial factual investigation.'),
  ];
  if (request.screenshots.length) {
    lines.push(
      request.screenshots.length === 1
        ? 'One screenshot of the order page is attached. Personal details are blacked out.'
        : request.screenshots.length +
            ' screenshot images are attached. They are consecutive top-to-bottom slices of one tall order page with slight overlap. Personal details are blacked out.',
    );
  }
  if (request.conversation.length) {
    lines.push('Conversation so far (untrusted context, oldest first):');
    for (const m of request.conversation) lines.push((m.role === 'user' ? 'Operator: ' : 'Assistant: ') + m.text);
  }
  if (request.previousDraft) lines.push('The operator\'s current draft (untrusted, may be edited):\n' + request.previousDraft);
  lines.push(
    'Structured capture (untrusted): ' + JSON.stringify(request.facts).slice(0, 9000),
    'Redacted page text (untrusted): ' + (request.redactedText || '').slice(0, 9000),
    'Do not interpret an adjustment as a won dispute without a verified decision.',
    'Return the strict JSON described in your instructions.',
  );
  return lines.join('\n');
}

/**
 * One follow-up turn in a saved conversation. The earlier turns are already in the agent's transcript, so this only
 * carries the new question, anything newly captured, the operator's current draft, and a note about the images.
 */
export function buildFollowUpPrompt({ question, previousDraft, additionalText, imageCount, storeId }) {
  const lines = ['Follow-up from the operator: ' + (question || 'Continue the investigation.')];
  if (storeId === UNRESOLVED_STORE) lines.push('The store is still unknown, so there is no history to search. Work from what you have.');
  if (imageCount) {
    lines.push(
      imageCount === 1
        ? 'The case evidence image is attached again below. Look at it again if the question needs it.'
        : imageCount + ' case evidence images are attached again below: consecutive top-to-bottom slices of the order page, then any extra photos the operator added. Personal details are blacked out. Look at them again if the question needs it, including any photo of the food or packaging.',
    );
  }
  if (additionalText) lines.push('Newly captured page text (untrusted): ' + additionalText.slice(0, 9000));
  if (previousDraft) lines.push("The operator's current draft (untrusted, may be edited):\n" + previousDraft);
  lines.push('Call tools only if you need facts you do not have. Return the strict JSON described in your instructions.');
  return lines.join('\n');
}
