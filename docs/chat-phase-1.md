# Trivu Chat — Phase 1 + voice notes (1.5) design

Status: design, not yet implemented.
Target: ~6–7 sprints (3–4 months).

## Problem

Spanish hospitals are notoriously bad at cross-department clinical
communication. The alpha customer (Cirugía Torácica — Hospital La Fe)
reports zero usage of Slack/Teams; coordination happens via WhatsApp
groups (when you have everyone's number), phone calls via the
switchboard (slow, often unanswered), and physical paging. A surgeon
who needs to reach an anesthesiologist on the third floor whose number
she doesn't have either calls the switchboard or asks a nurse to walk
a message.

WhatsApp can't solve this. It requires pre-knowing the phone number,
and the hospital's directory is a stale intranet Excel that nobody
updates. Email is too slow for clinical coordination.

Trivu already has the data layer that makes this solvable: every
clinician with an activated account is a Person row with a known role,
category, and schedule. The product opportunity is to layer cross-
tenant messaging on top so any clinician can find and reach any other
clinician in the same hospital, with rota context that consumer chat
tools can never have access to.

This doc covers Phase 1 + voice notes (1.5). Live calls, scheduling-
aware messaging, and case-bound threads are sketched in "Future
phases" but not designed here.

## Goals

- Org-wide directory: find any clinician in the same hospital by name,
  category, or department.
- 1:1 DMs between any two clinicians in the same org.
- Channels: any clinician creates a channel, invites others, posts and
  replies (no public/discoverable channels in P1).
- Email fallback for missed messages when the recipient is offline.
- Voice notes (≤2 min, async) as a first-class message type — Spanish
  clinical teams use these heavily on WhatsApp; not having them is a
  failure-to-adopt risk.
- Mobile-first delivery via PWA (no native apps in P1).

## Non-goals (deferred to later phases)

- Live voice/video calls (P2).
- `@guardia` / on-call routing (P2).
- Auto-generated case channels (P3).
- Group calls via SFU (P4).
- Public channels visible to non-members (later).
- Search across all conversations (start with per-conversation only).
- File attachments beyond voice notes (later — clinical docs raise
  compliance questions worth deferring).
- E2E encryption (later — TLS in transit + AES-at-rest is sufficient
  for P1 traffic, assuming PHI policy below).

## Data model

### Organizations

New top-level entity above Tenant. Multiple Tenants can roll up under
one Organization (= one hospital).

```
organizations
  id                serial primary key
  slug              varchar(64) unique
  name              varchar(255)
  country_code      varchar(8)
  region_code       varchar(16) null
  created_at        timestamptz
```

```
tenants
  + organization_id integer null references organizations(id) on delete set null
```

NULL `organization_id` = standalone tenant (the default — most
customers will sign as individual departments before any hospital-
wide deal). A clinician with memberships in tenants A and B both
under organization X is part of org X's directory and can DM anyone
else in org X.

Migration plan for existing tenants: stays NULL. No retroactive
grouping. When the first hospital-wide deal lands, we'll write a
one-off SQL to roll the relevant tenants under the new org.

### Conversations

```
conversations
  id                    serial primary key
  organization_id       integer not null references organizations(id) on delete cascade
  kind                  varchar(16) check (kind in ('dm', 'channel'))
  name                  varchar(255) null   -- channel only
  topic                 text null           -- channel only
  created_by_person_id  integer null references persons(id) on delete set null
  archived_at           timestamptz null
  created_at            timestamptz
  last_message_at       timestamptz null    -- denormalized, updated on send for cheap sort
```

```
conversation_members
  id                     serial primary key
  conversation_id        integer not null references conversations(id) on delete cascade
  person_id              integer not null references persons(id) on delete cascade
  role                   varchar(16) check (role in ('member', 'admin')) default 'member'
  notification_pref      varchar(16) check (notification_pref in ('all', 'mentions', 'mute')) default 'all'
  last_read_message_id   integer null references messages(id) on delete set null
  joined_at              timestamptz
  unique (conversation_id, person_id)
```

DMs always have exactly two members; channels have ≥1.

DM uniqueness invariant: for any pair (person_a, person_b) in the
same organization there's at most one `dm` conversation. Enforced at
write time by the "find-or-create DM" endpoint (see API below) rather
than by a constraint, because the natural index would be on
sorted-pair-of-person-ids which doesn't compose cleanly with the
existing schema.

### Messages

```
messages
  id                serial primary key
  conversation_id   integer not null references conversations(id) on delete cascade
  author_person_id  integer null references persons(id) on delete set null
  body              text null              -- nullable for voice-note-only messages
  voice_note_id     integer null references voice_notes(id) on delete set null
  parent_message_id integer null references messages(id) on delete set null  -- threads
  edited_at         timestamptz null
  deleted_at        timestamptz null       -- soft-delete; UI renders "mensaje borrado"
  created_at        timestamptz
  check (body is not null or voice_note_id is not null)
```

Indexes: `(conversation_id, created_at desc)` for the primary list,
`(author_person_id)` for "messages by this person" admin views.

### Voice notes

```
voice_notes
  id                serial primary key
  organization_id   integer not null references organizations(id) on delete cascade
  author_person_id  integer null references persons(id) on delete set null
  duration_seconds  integer
  file_key          varchar(255)            -- path within object storage
  mime_type         varchar(64)             -- audio/webm or audio/mp4
  byte_size         integer
  created_at        timestamptz
```

Files live on the same object-storage pattern as avatars: host volume
mounted as `/srv/albus/voice-notes` in the api container. Sharded
`/{org_id}/{yyyy-mm}/{voice_note_id}.{ext}` for clean export/deletion
if a hospital ever offboards.

### RLS

Same tenant-isolation pattern we already use, except scoped to
organization for these tables (a member can read conversations + their
messages + voice notes from any of their org's conversations). A
caller's "current org" is derived from their current tenant's
`organization_id` (or NULL for standalone-tenant callers, in which
case these tables are invisible — chat is gated on org membership).

## API surface

All endpoints authenticated, all scoped to the caller's organization.

### Directory

```
GET /api/org/directory?q=<search>&category=<id>&tenant=<id>&limit=50
```

Returns a paginated list of clinicians in the caller's org. Search is
case-insensitive prefix match on first/last/composite name. `category`
and `tenant` filters are optional.

Response per person includes `person_id`, name, category, group_name,
tenant_name, and `existing_dm_conversation_id` if a DM already exists
between caller and this person (so the UI can show "Open chat" instead
of "Start chat").

### Conversations

```
GET /api/conversations
```

Returns conversations the caller is a member of, sorted by
`last_message_at desc`. Includes `unread_count`, last-message preview,
member count (channels), other-person info (DMs).

```
POST /api/conversations
{ "kind": "channel", "name": "Trasplantes — coordinación", "member_person_ids": [12, 17, 22] }
```

Caller becomes channel admin; specified persons become members.

```
POST /api/conversations/dm
{ "other_person_id": 12 }
```

Idempotent — returns existing DM if one already exists between caller
and `other_person_id`.

```
GET /api/conversations/{id}
PATCH /api/conversations/{id}        # rename / archive (channel)
POST /api/conversations/{id}/members  # add to channel (channel admin only)
DELETE /api/conversations/{id}/members/{person_id}  # remove (admin, or self leaving)
POST /api/conversations/{id}/read     # body: {message_id} — set last_read_message_id
```

### Messages

```
GET /api/conversations/{id}/messages?before=<id>&limit=50
```

Reverse-chronological pagination. `before=<message_id>` returns the 50
messages older than the supplied id (for infinite scroll back).

```
POST /api/conversations/{id}/messages
{ "body": "Pedro, ¿confirmamos el cambio?", "parent_message_id": null }
# or
{ "voice_note_id": 17, "parent_message_id": 42 }
```

Updates `conversations.last_message_at`. Triggers notification fan-out
(see below).

```
PATCH /api/messages/{id}    # edit body (author only, within 5min)
DELETE /api/messages/{id}   # soft-delete (author, or channel admin)
```

### Voice notes

```
POST /api/voice-notes        # multipart upload, returns {id, duration_seconds, signed_play_url}
GET  /api/voice-notes/{id}/audio   # streams audio (org-scoped, signed-URL alternative)
```

The signed URL approach avoids the API proxying audio bytes through
Python — the URL points directly at the object-storage mount served
by the existing static file handler used for avatars.

### Real-time delivery

For P1: no websockets. The chat UI polls `GET /api/conversations` every
5–10s when open. Polling is enough for the alpha customer's scale (~20
people). A single websocket connection per session for instant delivery
is a Phase 1.5 nice-to-have but not blocking.

Background notifications (the "you got a message while the app was
closed" case) ride on web-push (browser-level push), and on email as a
fallback for users who haven't enabled web-push permission.

## UI surface

### New routes

- **`/me/chat`** — primary chat surface. Two-pane on desktop
  (conversation list left, active conversation right); single-pane
  drill-down on mobile.
- **`/me/chat/{id}`** — deep link to a conversation (used by
  notifications + share-this-conversation flows).
- **`/admin/org`** — org-level admin (only present when
  `current_tenant.organization_id` is non-NULL). Manage which tenants
  are in the org, directory visibility rules, channel moderation.

### Sidebar entry

`/me`: add "Chat" between "Reuniones" and "Cambios" with an unread
badge. ViewSwitcher pill behavior unchanged.

### Components to build

- `<ChatLayout>` — two-pane shell, responsive collapse to single pane
  on small viewports.
- `<ConversationList>` — sorted by last_message_at desc, unread badges,
  channels visually grouped at top.
- `<MessageThread>` — virtualised reverse-chronological list, infinite
  scroll back, day-separator rows.
- `<MessageComposer>` — text input + microphone button + send. Enter
  sends, Shift+Enter newline.
- `<VoiceNoteRecorder>` — modal/inline: tap to start, tap to stop,
  cancel + send buttons. Shows live timer + a basic waveform via
  AnalyserNode.
- `<VoiceNoteBubble>` — playback UI with play/pause + scrubbable
  waveform progress (using the duration from voice_notes table).
- `<DirectorySearch>` — modal that opens on "New chat" / "Add to
  channel". Search-as-you-type, click to start DM or add to channel
  membership.

### Mobile-first delivery (PWA hardening)

In parallel to the chat work (or just before), the existing app
becomes a proper PWA:

- `manifest.json`: name, icons (180×180 apple-touch + 192/512 Android),
  `display: standalone`, brand theme color.
- Service worker: offline cache for the user's own schedule, last-50
  messages per recently-viewed conversation, app shell.
- Web-push: VAPID keys + permission-grant prompt + push delivery
  hooked to the message-sent event. iOS Safari 16.4+ supports this;
  earlier iOS users fall back to email notifications only.
- Install prompt: shown on `/me/chat` only after the user has sent ≥3
  messages, so we don't pester people who haven't decided to use it.

This is ~1–2 sprints of focused work. Native iOS/Android apps stay
off the table until a specific PWA limitation hurts adoption.

## Voice notes (Phase 1.5)

### Why they matter (and aren't an afterthought)

Clinical communication has a unique asynchronous pattern: the sender
is often free for a moment (between cases, between patients) but the
recipient is in surgery and can't take a call. A 20-second voice note
that says "Pedro, the donor's PaO₂ dropped, I'm pushing the implante
back two hours, call me if that breaks your schedule" is faster to
record than to type AND respectful of when the recipient checks.

WhatsApp made voice notes mainstream in Spanish clinical teams. Trivu
not having them on day one risks "people just keep using WhatsApp
because the voice-note workflow is missing" — even when the rest of
the chat is better integrated with the rota.

### Recording flow

1. Tap the microphone button in the composer.
2. Browser prompts for microphone permission (first time only).
3. Recording starts; UI shows a live timer + waveform + cancel/send
   buttons.
4. Max duration **120 seconds** hard cap (clinical contexts don't
   need long voice rambles; the cap prevents accidental long
   recordings if the user walks away).
5. On send: blob uploads via `POST /api/voice-notes` (multipart),
   then `POST /messages` with the returned `voice_note_id`.

`MediaRecorder` API in browsers handles the encoding. Format
preference: `audio/webm` with Opus codec where supported (Chrome,
Firefox, Android), falling back to `audio/mp4` (AAC) on iOS Safari
≤16. Typical size: ~30 KB per 10 seconds of speech.

### Playback

Stock HTML `<audio>` element pointing at the signed URL. Auto-pause
on tab change. Speed control (1× / 1.5× / 2×) is a nice-to-have but
not P1.5 — defer.

### Retention

Voice notes live as long as the parent message. Soft-deleting a
message marks the voice note for cleanup; a weekly cron job
hard-deletes orphaned files (no parent message or parent
hard-deleted >30d ago). No length cap on storage in P1 — clinical
context wants permanent records.

## Notifications

Three layers, evaluated in order per message-sent event:

1. **In-app**: every member of the conversation gets a live unread
   badge update on next poll (or via the future websocket).
2. **Web-push**: if recipient has granted notification permission AND
   their `notification_pref` is `all` (or `mentions` + the message
   mentions them), fire a web-push to all their registered devices.
3. **Email fallback**: if recipient has NOT granted web-push permission
   AND they've been "offline" for ≥5 minutes (no API activity), send a
   batched email at the 5-minute mark summarising all messages
   received in that window. DMs are batched separately from channel
   messages (probably nobody wants 12 emails about a busy guardia
   channel).

Web-push is non-blocking — if delivery fails (expired subscription,
etc.) we log it and proceed to email. Both layers are best-effort.

## Compliance posture (P1)

- **Transport**: TLS only (already enforced by Caddy).
- **At-rest**: voice notes encrypted at rest by the host filesystem
  (LUKS or equivalent — set up at infrastructure level, not
  application level).
- **PHI scope**: messages in P1 may contain non-identifiable clinical
  text ("Pedro está saturando", "donor lung viability questionable")
  but should NOT contain identifiable patient information (names,
  hospital IDs, photos). This is policy, not technical — surfaced via
  a one-time onboarding screen and reinforced in the composer
  placeholder text. If/when we accept PHI we trigger a much bigger
  compliance review (Spain's ENS, GDPR Art. 9, retention policies).
- **Audit log**: every message create / edit / delete is recorded
  with author, timestamp, conversation. Already implicit in the
  schema; surface via `/admin/org/audit` later.
- **Retention**: P1 = indefinite. Hospital admins can request bulk
  deletion via support ticket; we don't expose a self-serve "delete
  all chat" yet.

## Open questions / decisions needed

1. **Billing model for orgs.** Does a hospital sign one contract for
   the org, or do tenants under the org keep individual billing? The
   GTM strategy implies org-level pricing (enterprise sale, hospital
   IT signs once). Per-tenant billing inside an org gets messy.
2. **Cross-org messaging.** A clinician with memberships in two
   different hospitals (real case — academic medics) — does she see
   both directories? Likely current-tenant-determines-active-org for
   simplicity. Worth confirming.
3. **Channel discoverability.** P1 channels are invite-only. Public
   channels (browse + self-join) are a Phase 2 question.
4. **PHI policy strictness.** How hard do we enforce no-identifiable-
   info in messages? Composer warning? Server-side regex sniffer?
   Audit-only? Probably onboarding policy + audit-log review for P1,
   tighter for P2.
5. **Standalone tenants vs orgs.** Existing customers are standalone
   tenants (`organization_id IS NULL`). They have no chat. Do we
   auto-create a single-tenant org for them on demand, or require
   them to upgrade? Probably the former when they hit "Chat" for the
   first time — frictionless.

## Future phases preview

- **Phase 2 — scheduling-aware messaging + 1:1 calls.** `@guardia`
  expands to the on-call person; `@trasplante-326` opens the
  auto-generated case channel; "who's free Friday afternoon" works
  as a directory query. 1:1 audio calls via WebRTC, signaling rides
  on the message channel. TURN via Cloudflare Calls or Twilio.
  ~3–4 sprints.
- **Phase 3 — case-bound threads.** Every TransplantCase, every ICU
  stay, every surgical case auto-gets a persistent channel scoped to
  the team on the case. Clinical record becomes a living thread.
  Lifts the PHI policy to "yes, identifiable info expected" with
  compliance machinery to match. ~4–5 sprints + compliance work.
- **Phase 4 — group calls.** SFU via vendor (LiveKit Cloud or
  similar). ~3–4 sprints + recurring per-user-hour cost.

## Implementation order

1. Organization model migration + cross-tenant directory endpoint +
   minimal directory UI (~1 sprint).
2. Conversations + messages tables + DM endpoints + chat UI shell
   (~2 sprints).
3. Channels + member management (~1 sprint).
4. Voice notes (recorder + storage + playback) (~1 sprint).
5. PWA manifest + service worker + web-push (~1 sprint, can run
   in parallel).
6. Email-fallback notifications (existing email infra; integration
   only — ~1 sprint).

Total: ~6–7 sprints, sustainable pace. Each step is independently
shippable; the alpha customer can start using the chat as soon as
step 3 lands and add voice notes when step 4 does.
