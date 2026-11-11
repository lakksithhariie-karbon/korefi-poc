import { DRAFT_LIMITS, UNRESOLVED_STORE } from './constants.mjs';

const NAMES = { doordash: 'DoorDash', ubereats: 'Uber Eats', grubhub: 'Grubhub' };
const HISTORY_NOTE = "There are no platform order records to search for this order. The only history is KoreFi's own past cases at this store, from find_similar_disputes. Do not mention other platforms.";
// A notice that the platform's own dispute route is closed, such as Uber Eats' "can't be disputed" after 30 days.
const CLOSED = /\b(?:can(?:no|'|’)?t|cannot|can no longer|no longer) be disputed\b|\bdispute (?:window|period) (?:has )?(?:closed|expired|ended)\b/i;

/** The draft length rule for this platform, from the ops playbook. */
function lengthRule(platform) {
  const limit = DRAFT_LIMITS[platform];
  return limit
    ? 'Draft limit: at most ' + limit + ' characters, counting spaces (the ' + NAMES[platform] + ' dispute form).'
    : 'Draft limit: ' + NAMES[platform] + ' takes longer texts and has no evidence upload, so put the whole case in the text.';
}

/** What the page itself says about disputing this charge: a Dispute button, or a notice that disputes are closed. */
function disputeRoute(request) {
  const lines = [];
  const text = [request.facts?.notice, request.redactedText].filter(Boolean).join('\n');
  const closed = text.split(/\n|(?<=[.!?])\s+/).find((l) => CLOSED.test(l));
  if (closed) {
    lines.push(
      'The page says: "' + closed.trim().slice(0, 300) + '" The platform\'s dispute route for this charge is closed. Say so first, ' +
        'then make the case through the route the page still offers (for example Contact support) and write the draft for that route.',
    );
  }
  if (request.facts?.disputeStatus === 'available') lines.push('The page shows a Dispute button for this charge.');
  return lines;
}

/** The text sent to the agent for one turn. Exported so tests can check what the model is and is not told. */
export function buildPrompt(request) {
  const first = request.conversation.length === 0;
  const platform = request.platform || 'doordash';
  const lines = [
    'Platform: ' + NAMES[platform] + '.',
    'Order ' + request.orderId + ' at store ' + (request.storeId === UNRESOLVED_STORE ? 'unknown (no store ID was found)' : request.storeId) + '.',
    first
      ? platform === 'doordash'
        ? 'This is the first turn. Use the read-only tools for order financials, error charges, issue reports, historical patterns and prior cases.'
        : 'This is the first turn. ' + HISTORY_NOTE + ' Check prior KoreFi cases with the tool you have.'
      : 'This is a follow-up turn. Use the conversation below. Call tools only if you need facts you do not have.',
    'Reported issue: ' + (request.issueCategory || 'unknown') + '; description: ' + (request.issueDescription || 'none'),
    'Charge: ' + (request.amount ?? 'unknown') + ' USD.',
    ...disputeRoute(request),
    lengthRule(platform),
    'Operator question: ' + (request.operatorQuestion || 'Provide an initial factual investigation.'),
  ];
  if (request.screenshots.length) {
    const photos = Math.min(Number(request.facts?.attached_images?.customer_photos) || 0, request.screenshots.length);
    const slices = request.screenshots.length - photos;
    if (photos) {
      lines.push(
        (photos === 1 ? 'The first image is a photo' : 'The first ' + photos + ' images are photos') +
          ' the customer uploaded with their complaint, at full size. They are the customer\'s evidence, not proof.',
      );
    }
    if (slices) {
      lines.push(
        slices === 1
          ? 'One screenshot of the order page is attached' + (photos ? ' after the photos' : '') + '.'
          : slices + ' screenshot images of the order page are attached' + (photos ? ' after the photos' : '') +
              '. They are consecutive top-to-bottom slices of one tall page with slight overlap.',
      );
    }
  }
  if (request.conversation.length) {
    lines.push('Conversation so far (untrusted context, oldest first):');
    for (const m of request.conversation) lines.push((m.role === 'user' ? 'Operator: ' : 'Assistant: ') + m.text);
  }
  if (request.previousDraft) lines.push('The operator\'s current draft (untrusted, may be edited):\n' + request.previousDraft);
  lines.push(
    'Structured capture (untrusted): ' + JSON.stringify(request.facts).slice(0, 9000),
    'Page text (untrusted): ' + (request.redactedText || '').slice(0, 9000),
    'Do not interpret an adjustment as a won dispute without a verified decision.',
    'Return the strict JSON described in your instructions.',
  );
  return lines.join('\n');
}

/**
 * One follow-up turn in a saved conversation. The earlier turns are already in the agent's transcript, so this only
 * carries the new question, anything newly captured, the operator's current draft, and a note about the images.
 */
export function buildFollowUpPrompt({ question, previousDraft, additionalText, imageCount, storeId, platform = 'doordash' }) {
  const lines = ['Follow-up from the operator: ' + (question || 'Continue the investigation.'), 'Platform: ' + NAMES[platform] + '.', lengthRule(platform)];
  if (storeId === UNRESOLVED_STORE) lines.push('The store is still unknown, so there is no history to search. Work from what you have.');
  if (imageCount) {
    lines.push(
      imageCount === 1
        ? 'The case evidence image is attached again below. Look at it again if the question needs it.'
        : imageCount + ' case evidence images are attached again below, in the order they were added: customer photos and slices of the order page, as described when each was added. Look at them again if the question needs it, including any photo of the food or packaging.',
    );
  }
  if (additionalText) lines.push('Newly captured page text (untrusted): ' + additionalText.slice(0, 9000));
  if (previousDraft) lines.push("The operator's current draft (untrusted, may be edited):\n" + previousDraft);
  lines.push('Call tools only if you need facts you do not have. Return the strict JSON described in your instructions.');
  return lines.join('\n');
}
