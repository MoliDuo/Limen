import { after, NextResponse } from 'next/server';
import { db, type AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { processAIEntry } from '@/lib/ai/processor';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { loadApiEntriesPage } from '@/lib/dashboard-data';
import { authorizeApiRequest } from '@/lib/auth/security';
import { InputValidationError, parseEntryInput } from '@/lib/validation';
import { parsePageLimit } from '@/lib/pagination';
import { serializeApiEntry } from '@/lib/api/entry-serializer';
import { activeEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';

export const maxDuration = 60;
export const preferredRegion = 'sin1';

type RouteDeps = {
  db: AppDatabase;
  createId: () => string;
  processAIEntry: typeof processAIEntry;
  schedule: (fn: () => Promise<void>) => void | Promise<void>;
  authorizeRequest?: (request: Request) => Promise<boolean> | boolean;
};

function validationResponse(error: InputValidationError) {
  return NextResponse.json(
    { error: error.message },
    { status: error.code === 'too_large' ? 413 : 400 },
  );
}

export function createEntriesRouteHandlers({
  db: database,
  createId,
  processAIEntry,
  schedule,
  authorizeRequest = (request) => authorizeApiRequest(request, database),
}: RouteDeps) {
  return {
    async POST(request: Request) {
      if (!(await authorizeRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      let id: string | null = null;
      let aiStatus = 'pending';
      try {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json(
            { error: 'Invalid JSON body' },
            { status: 400 },
          );
        }
        if (!body || typeof body !== 'object') {
          return NextResponse.json(
            { error: 'Request body must be a JSON object' },
            { status: 400 },
          );
        }
        const { content, createdAt } = body as {
          content?: unknown;
          createdAt?: unknown;
        };
        const input = parseEntryInput(content, createdAt);

        id = createId();
        const now = new Date();
        const cipher = await getFieldCipher(database);
        const inserted = await database
          .insert(entries)
          .values({
            id,
            content: cipher.encryptEntryField(id, 'content', input.content),
            source: 'web',
            aiStatus: 'pending',
            createdAt: input.createdAt,
            recordedAt: now,
            updatedAt: now,
          })
          .returning({ id: entries.id });
        if (inserted[0]?.id !== id)
          throw new Error('Entry insert not confirmed');

        try {
          await schedule(async () =>
            processAIEntry(id as string, input.content),
          );
        } catch (error) {
          console.error(`AI scheduling failed for entry ${id}:`, error);
          aiStatus = 'failed';
          await database
            .update(entries)
            .set({ aiStatus, updatedAt: new Date() })
            .where(activeEntries(eq(entries.id, id as string)));
        }
        return NextResponse.json(
          { id, status: 'created', aiStatus },
          {
            status: 201,
            headers: { Location: `/api/entries/${id}` },
          },
        );
      } catch (error) {
        if (error instanceof InputValidationError)
          return validationResponse(error);
        console.error(`Error creating entry${id ? ` ${id}` : ''}:`, error);
        return NextResponse.json(
          { error: 'Internal Server Error' },
          { status: 500 },
        );
      }
    },

    async GET(request: Request) {
      if (!(await authorizeRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const params = new URL(request.url).searchParams;
        const limit = parsePageLimit(params.get('limit'));
        const cursor = params.get('cursor') ?? undefined;
        const page = await loadApiEntriesPage({ limit, cursor }, database);
        return NextResponse.json({
          ...page,
          items: page.items.map(serializeApiEntry),
        });
      } catch (error) {
        if (error instanceof InputValidationError)
          return validationResponse(error);
        console.error('Error fetching entries:', error);
        return NextResponse.json(
          { error: 'Internal Server Error' },
          { status: 500 },
        );
      }
    },
  };
}

const routeHandlers = createEntriesRouteHandlers({
  db,
  createId: () => nanoid(12),
  processAIEntry,
  schedule: (fn) => after(fn),
});

export const POST = routeHandlers.POST;
export const GET = routeHandlers.GET;
