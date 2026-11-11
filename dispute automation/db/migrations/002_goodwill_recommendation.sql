-- The agent can now recommend 'goodwill': ask the platform for a reversal without disputing, when the evidence is on
-- the customer's side (from the ops playbook). Both columns that store a recommendation accept it. Nothing else changes.
-- Apply with `npm run migrate` as an owner role, before the service that sends 'goodwill' goes live.

ALTER TABLE dispute_automation.investigations DROP CONSTRAINT IF EXISTS investigations_recommendation_check;
ALTER TABLE dispute_automation.investigations ADD CONSTRAINT investigations_recommendation_check
  CHECK (recommendation IS NULL OR recommendation IN ('dispute', 'goodwill', 'needs_review', 'do_not_dispute'));

ALTER TABLE dispute_automation.conversations DROP CONSTRAINT IF EXISTS conversations_last_recommendation_check;
ALTER TABLE dispute_automation.conversations ADD CONSTRAINT conversations_last_recommendation_check
  CHECK (last_recommendation IS NULL OR last_recommendation IN ('dispute', 'goodwill', 'needs_review', 'do_not_dispute'));
