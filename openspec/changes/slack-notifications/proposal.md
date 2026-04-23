## Why

Veto-window alerts and human-tiebreaker escalations need a human-visible signal outside Linear and the Temporal UI. Slack is where engineers already live; piping these two moments there closes the loop between autonomous pipeline and human attention.

## What Changes

- Add `@slack/web-api` dependency.
- Add `server/src/slack/client.ts` with two narrow methods:
  - `notifyVetoWindow(ticket, prNumber, vetoDeadline)` — posts to the configured auto-merge channel with a Temporal workflow deep link and a "cancel" button that sends a `vetoOverride` signal.
  - `notifyTiebreaker(ticket, prNumber, perPersonaReasoning)` — posts to the tiebreak channel with each persona's reasoning inline.
- Channel routing via env vars (`SLACK_AUTO_MERGE_CHANNEL`, `SLACK_TIEBREAK_CHANNEL`).
- Slack button interaction handled via a small webhook endpoint (`server/src/routes/slack-interactions.ts`) that translates button presses into Temporal signals.

## Capabilities

### New Capabilities

- `slack-alerts`: Veto-window and tiebreaker notifications with workflow deep links, per-persona reasoning rendering, and interactive veto button → Temporal signal.

### Modified Capabilities

(none — new surface)

## Impact

- New dep: `@slack/web-api`.
- New files: `server/src/slack/client.ts`, `server/src/slack/signatures.ts`, `server/src/routes/slack-interactions.ts`.
- New env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_AUTO_MERGE_CHANNEL`, `SLACK_TIEBREAK_CHANNEL`.
- The webhook endpoint requires a publicly reachable URL; use ngrok-equivalent in dev, a stable ingress in prod.
- Consumed by `vote-aggregator`.
