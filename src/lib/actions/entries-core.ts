import type { AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { processAIEntry as runAI } from '@/lib/ai/processor';
import { revalidatePath as nextRevalidatePath } from 'next/cache';
import { eq, inArray } from 'drizzle-orm';
import { activeEntries, trashedEntries } from '@/lib/db/entry-scope';
import { dashboardPath, entryDetailPath, trashPath } from '@/lib/pathname';
import { messages } from '@/lib/messages';
import { findActiveEntry } from '@/lib/db/entries-repo';
import { syncEntryTags } from '@/lib/db/entry-tags';
import {
  normalizeTagsInput,
  normalizeTitleInput,
} from '@/lib/entry-metadata-editor';
import {
  InputValidationError,
  normalizeEntryIds,
  parseEntryInput,
} from '@/lib/validation';
import type { ActionResult } from '@/lib/actions/result';
import { getFieldCipher } from '@/lib/crypto/cipher';

type EntryActionDeps = {
  db: AppDatabase;
  createId: () => string;
  scheduleAI: (job: () => Promise<void>) => void | Promise<void>;
  processAIEntry: typeof runAI;
  revalidatePath: typeof nextRevalidatePath;
  authorize?: () => unknown | Promise<unknown>;
  processAIEntries?: (
    items: Array<{ id: string; content: string }>,
  ) => Promise<void>;
};

export function createEntryActions({
  db,
  createId,
  scheduleAI,
  processAIEntry,
  revalidatePath,
  authorize = () => {},
  processAIEntries,
}: EntryActionDeps) {
  return {
    async createEntry(
      formData: FormData,
    ): Promise<ActionResult<{ id: string; redirectTo: string }>> {
      await authorize();
      let input;
      try {
        input = parseEntryInput(
          formData.get('content'),
          formData.get('createdAt'),
        );
      } catch (error) {
        if (error instanceof InputValidationError)
          return { ok: false, error: error.message };
        throw error;
      }

      const id = createId();
      const now = new Date();
      const cipher = await getFieldCipher(db);
      await db.insert(entries).values({
        id,
        content: cipher.encryptEntryField(id, 'content', input.content),
        source: 'web',
        aiStatus: 'pending',
        createdAt: input.createdAt,
        recordedAt: now,
        updatedAt: now,
      });

      try {
        await scheduleAI(async () => {
          await processAIEntry(id, input.content).catch((err) => {
            console.error(
              `AI background processing failed for entry ${id}:`,
              err,
            );
          });
        });
      } catch (error) {
        console.error(`AI scheduling failed for entry ${id}:`, error);
        await db
          .update(entries)
          .set({ aiStatus: 'failed', updatedAt: new Date() })
          .where(eq(entries.id, id));
      }

      revalidatePath(dashboardPath());
      return { ok: true, data: { id, redirectTo: dashboardPath() } };
    },

    /** Soft delete: the entry moves to the recycle bin for 30 days. */
    async deleteEntry(
      id: string,
    ): Promise<
      ActionResult<{ id: string; title: string | null; redirectTo: string }>
    > {
      await authorize();
      const now = new Date();
      const deleted = await db
        .update(entries)
        .set({ deletedAt: now, updatedAt: now })
        .where(activeEntries(eq(entries.id, id)))
        // The title rides along so the undo toast can name the entry.
        .returning({ id: entries.id, title: entries.title });
      const row = deleted[0];
      if (!row) return { ok: false, error: messages.common.entryNotFound };
      const cipher = await getFieldCipher(db);
      revalidatePath(dashboardPath());
      revalidatePath(trashPath());
      return {
        ok: true,
        data: {
          id,
          title: cipher.decryptEntryField(id, 'title', row.title),
          redirectTo: dashboardPath(),
        },
      };
    },

    async restoreEntry(id: string): Promise<ActionResult<{ id: string }>> {
      await authorize();
      // Deliberately does not re-run the AI or touch tags_locked_at: a restore
      // must return the entry exactly as it was.
      const restored = await db
        .update(entries)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(trashedEntries(eq(entries.id, id)))
        .returning({ id: entries.id });
      if (restored.length === 0)
        return { ok: false, error: messages.common.entryNotFound };
      revalidatePath(dashboardPath());
      revalidatePath(entryDetailPath(id));
      revalidatePath(trashPath());
      return { ok: true, data: { id } };
    },

    /** Permanent. Guarded so only something already in the bin can be purged. */
    async purgeEntry(id: string): Promise<ActionResult<{ id: string }>> {
      await authorize();
      const purged = await db
        .delete(entries)
        .where(trashedEntries(eq(entries.id, id)))
        .returning({ id: entries.id });
      if (purged.length === 0)
        return { ok: false, error: messages.common.entryNotFound };
      revalidatePath(trashPath());
      return { ok: true, data: { id } };
    },

    /**
     * Hand-edited tags. Sets tags_locked_at so the AI stops overwriting them;
     * syncEntryTags is called with respectLock: false because this IS the
     * owner speaking.
     */
    async setEntryTags(
      id: string,
      names: string[],
    ): Promise<ActionResult<{ id: string; tags: string[] }>> {
      await authorize();
      const normalized = normalizeTagsInput(names);
      const entry = await findActiveEntry(id, db);
      if (!entry) return { ok: false, error: messages.common.entryNotFound };

      await syncEntryTags(db, id, normalized, { respectLock: false });
      await db
        .update(entries)
        .set({ tagsLockedAt: new Date(), updatedAt: new Date() })
        .where(activeEntries(eq(entries.id, id)));

      revalidatePath(dashboardPath());
      revalidatePath(entryDetailPath(id));
      return { ok: true, data: { id, tags: normalized } };
    },

    async setEntryTitle(
      id: string,
      title: unknown,
    ): Promise<ActionResult<{ id: string; title: string | null }>> {
      await authorize();
      const normalized = normalizeTitleInput(title);
      const cipher = await getFieldCipher(db);
      const updated = await db
        .update(entries)
        .set({
          title: cipher.encryptEntryField(id, 'title', normalized),
          titleLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(activeEntries(eq(entries.id, id)))
        .returning({ id: entries.id });
      if (updated.length === 0)
        return { ok: false, error: messages.common.entryNotFound };

      revalidatePath(dashboardPath());
      revalidatePath(entryDetailPath(id));
      return { ok: true, data: { id, title: normalized } };
    },

    /** Hands title and tags back to the AI on the next regeneration. */
    async unlockEntryMetadata(
      id: string,
    ): Promise<ActionResult<{ id: string }>> {
      await authorize();
      const updated = await db
        .update(entries)
        .set({ titleLockedAt: null, tagsLockedAt: null, updatedAt: new Date() })
        .where(activeEntries(eq(entries.id, id)))
        .returning({ id: entries.id });
      if (updated.length === 0)
        return { ok: false, error: messages.common.entryNotFound };
      revalidatePath(entryDetailPath(id));
      return { ok: true, data: { id } };
    },

    async updateEntry(
      id: string,
      formData: FormData,
    ): Promise<ActionResult<{ id: string; redirectTo: string }>> {
      await authorize();
      let input;
      try {
        input = parseEntryInput(
          formData.get('content'),
          formData.get('createdAt'),
        );
      } catch (error) {
        if (error instanceof InputValidationError)
          return { ok: false, error: error.message };
        throw error;
      }

      // The previous title/summary/tags stay until the AI produces new ones.
      // Clearing them up front meant a failed AI call destroyed good metadata
      // permanently: fixing one typo could cost you the entry's title.
      const cipher = await getFieldCipher(db);
      const updated = await db
        .update(entries)
        .set({
          content: cipher.encryptEntryField(id, 'content', input.content),
          aiStatus: 'pending',
          createdAt: input.createdAt,
          updatedAt: new Date(),
        })
        .where(activeEntries(eq(entries.id, id)))
        .returning({ id: entries.id });
      if (updated.length === 0)
        return { ok: false, error: messages.common.entryNotFound };

      await scheduleAI(async () => {
        await processAIEntry(id, input.content).catch((err) => {
          console.error(`AI update processing failed for entry ${id}:`, err);
        });
      });

      revalidatePath(dashboardPath());
      revalidatePath(entryDetailPath(id));
      return { ok: true, data: { id, redirectTo: entryDetailPath(id) } };
    },

    async regenerateEntryMetadata(
      id: string,
    ): Promise<ActionResult<{ id: string }>> {
      await authorize();
      const entry = await findActiveEntry(id, db);
      if (!entry) {
        return { ok: false, error: messages.common.entryNotFound };
      }

      const content = entry.content;

      await db
        .update(entries)
        .set({
          aiStatus: 'pending',
          updatedAt: new Date(),
        })
        .where(activeEntries(eq(entries.id, id)));

      await scheduleAI(async () => {
        await processAIEntry(id, content).catch((err) => {
          console.error(`AI regeneration failed for entry ${id}:`, err);
        });
      });

      revalidatePath(dashboardPath());
      revalidatePath(entryDetailPath(id));
      return { ok: true, data: { id } };
    },

    async bulkRegenerateEntryMetadata(
      ids: string[],
    ): Promise<ActionResult<{ ids: string[] }>> {
      await authorize();
      const normalizedIds = normalizeEntryIds(ids);
      if (normalizedIds.length === 0) return { ok: true, data: { ids: [] } };

      const cipher = await getFieldCipher(db);
      const foundEntries = await db
        .select({ id: entries.id, content: entries.content })
        .from(entries)
        .where(activeEntries(inArray(entries.id, normalizedIds)));
      const entryMap = new Map(
        foundEntries.map((entry) => [
          entry.id,
          {
            id: entry.id,
            content: cipher.decryptEntryField(
              entry.id,
              'content',
              entry.content,
            ),
          },
        ]),
      );

      await db
        .update(entries)
        .set({
          aiStatus: 'pending',
          updatedAt: new Date(),
        })
        .where(activeEntries(inArray(entries.id, normalizedIds)));

      await scheduleAI(async () => {
        const jobs = normalizedIds.flatMap((id) => {
          const entry = entryMap.get(id);
          return entry ? [{ id, content: entry.content }] : [];
        });
        if (processAIEntries) {
          await processAIEntries(jobs);
          return;
        }
        for (const job of jobs) await processAIEntry(job.id, job.content);
      });

      revalidatePath(dashboardPath());
      return {
        ok: true,
        data: { ids: jobsForResult(normalizedIds, entryMap) },
      };
    },

    async bulkDeleteEntries(
      ids: string[],
    ): Promise<ActionResult<{ ids: string[] }>> {
      await authorize();
      const normalizedIds = normalizeEntryIds(ids);
      if (normalizedIds.length === 0) return { ok: true, data: { ids: [] } };

      const now = new Date();
      const deleted = await db
        .update(entries)
        .set({ deletedAt: now, updatedAt: now })
        .where(activeEntries(inArray(entries.id, normalizedIds)))
        .returning({ id: entries.id });
      revalidatePath(dashboardPath());
      revalidatePath(trashPath());
      return { ok: true, data: { ids: deleted.map((entry) => entry.id) } };
    },
  };
}

function jobsForResult(ids: string[], entryMap: Map<string, { id: string }>) {
  return ids.filter((id) => entryMap.has(id));
}
