"""Voice notes for chat.

Adds audio messages: a `voice_notes` table for the file metadata and
a nullable `messages.voice_note_id` FK so a message can be text, a
voice note, or (degenerate) both. The file bytes live on disk under a
host volume (/srv/albus/voice-notes), same pattern as avatars — only
the metadata is in Postgres.

Tables / columns:
  voice_notes
    id, hospital_id (scope), author_person_id (SET NULL on delete),
    duration_seconds, file_key (path within the volume), mime_type,
    byte_size, created_at
  messages
    + voice_note_id  INT NULL  (SET NULL — if the audio is purged the
                                message row survives as a tombstone)
    body is now NULLABLE (a voice-note-only message has no text)

Constraints:
  - ck_messages_body_or_voice: a message must carry *something* —
    either a body or a voice note.

Scope / RLS: `voice_notes` is hospital-scoped with no RLS, exactly
like `conversations` / `messages` — access is enforced at the route
layer (you can only read a voice note attached to a message in a
conversation you belong to). The audio is served through an
access-checked endpoint, not a public static mount.

Revision ID: 0093_voice_notes
Revises: 0092_conversation_context
Create Date: 2026-06-01
"""

from alembic import op


revision = "0093_voice_notes"
down_revision = "0092_conversation_context"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE voice_notes (
            id                SERIAL PRIMARY KEY,
            hospital_id       INTEGER NOT NULL
                                  REFERENCES hospitals(id) ON DELETE CASCADE,
            author_person_id  INTEGER
                                  REFERENCES persons(id) ON DELETE SET NULL,
            duration_seconds  INTEGER NOT NULL DEFAULT 0,
            file_key          VARCHAR(255) NOT NULL,
            mime_type         VARCHAR(64)  NOT NULL,
            byte_size         INTEGER NOT NULL DEFAULT 0,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_voice_notes_hospital ON voice_notes (hospital_id);

        ALTER TABLE messages
            ADD COLUMN voice_note_id INTEGER
                REFERENCES voice_notes(id) ON DELETE SET NULL;

        -- Voice-note-only messages carry no text.
        ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;

        ALTER TABLE messages
            ADD CONSTRAINT ck_messages_body_or_voice
            CHECK (body IS NOT NULL OR voice_note_id IS NOT NULL);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE messages
            DROP CONSTRAINT IF EXISTS ck_messages_body_or_voice;
        -- Restore NOT NULL: backfill any voice-note-only rows to '' so
        -- the constraint can be re-applied.
        UPDATE messages SET body = '' WHERE body IS NULL;
        ALTER TABLE messages ALTER COLUMN body SET NOT NULL;
        ALTER TABLE messages DROP COLUMN IF EXISTS voice_note_id;
        DROP TABLE IF EXISTS voice_notes;
        """
    )
