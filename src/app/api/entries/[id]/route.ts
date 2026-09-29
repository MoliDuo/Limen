import { NextResponse } from 'next/server';
import { db, type AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { authorizeApiRequest } from '@/lib/auth/security';
import { findActiveEntry } from '@/lib/db/entries-repo';
import { activeEntries } from '@/lib/db/entry-scope';
import { serializeApiEntry } from '@/lib/api/entry-serializer';

export const maxDuration = 60;
export const preferredRegion = 'sin1';

type RouteDeps = {
  db: AppDatabase;
  authorizeRequest?: (request: Request) => Promise<boolean> | boolean;
  now?: () => Date;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createEntryDetailRouteHandlers({
  db: database,
  authorizeRequest = (request) => authorizeApiRequest(request, database),
  now = () => new Date(),
}: RouteDeps) {
  return {
    async GET(request: Request, { params }: RouteContext) {
      if (!(await authorizeRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { id } = await params;
      try {
        const entry = await findActiveEntry(id, database);
        if (!entry) {
          return NextResponse.json(
            { error: 'Entry not found' },
            { status: 404 },
          );
        }
        return NextResponse.json(serializeApiEntry(entry));
      } catch (error) {
        console.error(`Error fetching entry ${id}:`, error);
        return NextResponse.json(
          { error: 'Internal Server Error' },
          { status: 500 },
        );
      }
    },

    /**
     * Soft delete. The documented client is the owner's own Shortcut, so a
     * misfire has to be recoverable; a hard delete here would also give the
     * app two deletion paths, one of which ignores the 30-day promise the
     * recycle bin makes.
     */
    async DELETE(request: Request, { params }: RouteContext) {
      if (!(await authorizeRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { id } = await params;
      try {
        const deletedAt = now();
        const result = await database
          .update(entries)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(activeEntries(eq(entries.id, id)))
          .returning({ id: entries.id });

        if (result.length === 0) {
          return NextResponse.json(
            { error: 'Entry not found' },
            { status: 404 },
          );
        }
        return NextResponse.json({
          success: true,
          deletedAt: deletedAt.toISOString(),
        });
      } catch (error) {
        console.error(`Error deleting entry ${id}:`, error);
        return NextResponse.json(
          { error: 'Internal Server Error' },
          { status: 500 },
        );
      }
    },
  };
}

const handlers = createEntryDetailRouteHandlers({ db });

export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
