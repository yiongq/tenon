import { z } from 'zod'
import { defineRoute } from '../route.js'
import { canonicalSessionIdSchema } from './session.js'

/** Spec 05 §接口: identities and calls come from Tape in the kernel, never from the renderer. */
const sessionTarget = z.object({ sessionId: canonicalSessionIdSchema }).strict()
const roundTarget = sessionTarget.extend({ roundRunId: canonicalSessionIdSchema })
// Restates kernel isAbsolutePath without importing the kernel into the sandboxed preload.
const path = z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\0]*$/u, 'not an absolute path')
const paths = z.array(path).readonly()
const count = z.number().int().nonnegative()
const opaqueId = z.string().min(1)
const refusal = z
  .object({
    ok: z.literal(false),
    code: z.enum(['busy', 'gone', 'stale', 'undo-unavailable', 'over-budget', 'not-cowork']),
  })
  .strict()

/** Reads the kernel's rounds and startup evidence; it neither resumes nor applies a restore. */
export const snapshotRounds = defineRoute('snapshot.rounds', {
  request: sessionTarget,
  response: z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        status: z.enum(['tree', 'warming', 'file-only', 'unavailable']),
        rounds: z
          .array(
            z
              .object({
                roundRunId: canonicalSessionIdSchema,
                runIds: z.array(canonicalSessionIdSchema).readonly(),
                endMessageId: opaqueId.nullable(),
                calls: z
                  .array(z.object({ callKey: opaqueId, snapshotId: opaqueId }).strict())
                  .readonly(),
                canRestore: z.boolean(),
                incompleteCoverage: z.boolean(),
                commandsWithoutSnapshot: z.boolean(),
              })
              .strict(),
          )
          .readonly(),
        incompleteRestores: z
          .array(
            z
              .object({
                entryId: count,
                roundRunId: canonicalSessionIdSchema,
                undoSnapshotId: opaqueId,
                previewKey: opaqueId,
              })
              .strict(),
          )
          .readonly(),
      })
      .strict(),
    refusal,
  ]),
})

/** Read-only preview, serialized by the kernel's root mailbox. */
export const snapshotPreview = defineRoute('snapshot.preview', {
  request: roundTarget,
  response: z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        preview: z
          .object({
            previewKey: opaqueId,
            restore: paths,
            remove: paths,
            conflicts: paths,
            skipped: z
              .array(
                z
                  .object({
                    path,
                    reason: z.enum(['excluded', 'not-covered', 'hardlink', 'outside-folders']),
                    promised: z.literal(true).exactOptional(),
                  })
                  .strict(),
              )
              .readonly(),
          })
          .strict(),
      })
      .strict(),
    refusal,
  ]),
})

/** Only conflict choices cross this boundary; no folder, snapshot identity or call list is input. */
export const snapshotRestore = defineRoute('snapshot.restore', {
  // Bound IPC work to 50,000 choices (one default tree's file budget); larger rounds
  // can still restore with the remaining conflicts kept. This is a request limit, not a tree limit.
  request: roundTarget.extend({
    previewKey: opaqueId,
    overwrite: z.array(path).max(50_000).readonly(),
  }),
  response: z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        undoSnapshotId: opaqueId,
        restored: count,
        removed: count,
        kept: count,
        skipped: count,
        failed: paths,
      })
      .strict(),
    refusal,
  ]),
})
