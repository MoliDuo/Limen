import OpenAI from 'openai';
import { z } from 'zod';
import { db, type AppDatabase } from '@/lib/db';
import { entries } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { normalizeTags } from '@/lib/tags';
import { listActiveTagNames, syncEntryTags } from '@/lib/db/entry-tags';
import { activeEntries } from '@/lib/db/entry-scope';
import { getFieldCipher } from '@/lib/crypto/cipher';

const AI_CHUNK_LENGTH = 30_000;
const CHUNK_CONCURRENCY = 3;
const ENTRY_CONCURRENCY = 2;

const aiResponseSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string()).max(10),
  })
  .strict();

export type AIResponse = z.infer<typeof aiResponseSchema>;

/**
 * Tag candidates offered to the model. Backed by the tags tables, so this is
 * an indexed lookup instead of the full scan of entries.tags it used to be.
 */
export async function getExistingTags(database: AppDatabase) {
  return listActiveTagNames(database);
}

type AIClient = {
  chat: {
    completions: {
      create: (request: {
        model: string;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
        response_format: { type: 'json_object' };
      }) => Promise<{
        choices: { message: { content: string | null } }[];
      }>;
    };
  };
};

type ProcessorDeps = {
  db: AppDatabase;
  client: AIClient;
  model?: string;
};

function createOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

function parseAIResponse(content: string | null): AIResponse {
  const parsed = aiResponseSchema.parse(JSON.parse(content || '{}'));
  return { ...parsed, tags: normalizeTags(parsed.tags) };
}

function systemPrompt(existingTags: string[], context?: string) {
  return `你是一个帮助我整理日记记录的助手。
请严格遵守以下规则：
1. title 和 summary 必须使用第一人称“我”的视角。
2. title 要短，抓住核心；summary 准确概括输入内容。
3. tags 优先复用已有标签，最多 10 个。
4. 只返回包含 title、summary、tags 的 JSON。
现有标签候选：${existingTags.join(', ') || '无'}${context ? `\n${context}` : ''}`;
}

async function requestMetadata(
  client: AIClient,
  model: string,
  content: string,
  existingTags: string[],
  context?: string,
) {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt(existingTags, context) },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
  });
  return parseAIResponse(response.choices[0]?.message.content ?? null);
}

async function generateMetadata(
  client: AIClient,
  model: string,
  content: string,
  existingTags: string[],
) {
  if (content.length <= AI_CHUNK_LENGTH) {
    return requestMetadata(client, model, content, existingTags);
  }

  const chunks = Array.from(
    { length: Math.ceil(content.length / AI_CHUNK_LENGTH) },
    (_, index) =>
      content.slice(index * AI_CHUNK_LENGTH, (index + 1) * AI_CHUNK_LENGTH),
  );
  const partials = await mapWithConcurrency(
    chunks,
    CHUNK_CONCURRENCY,
    (chunk, index) =>
      requestMetadata(
        client,
        model,
        chunk,
        existingTags,
        `这是长篇日记的第 ${index + 1}/${chunks.length} 段，请只概括本段。`,
      ),
  );
  return requestMetadata(
    client,
    model,
    JSON.stringify(partials),
    existingTags,
    '输入是各分段的结构化概括，请汇总为整篇日记的最终元数据。',
  );
}

export function createAIProcessor({
  db: database,
  client,
  model = process.env.AI_MODEL || 'gpt-4o-mini',
}: ProcessorDeps) {
  return async function processAIEntry(
    entryId: string,
    content: string,
    existingTags?: string[],
  ) {
    try {
      const tags = existingTags ?? (await getExistingTags(database));
      const aiResult = await generateMetadata(client, model, content, tags);
      const cipher = await getFieldCipher(database);
      // The title is skipped when the owner has renamed the entry; the summary
      // and status always refresh so the lifecycle still completes.
      await database
        .update(entries)
        .set({
          title: sql`case when ${entries.titleLockedAt} is null
            then ${cipher.encryptEntryField(entryId, 'title', aiResult.title)}
            else ${entries.title} end`,
          summary: cipher.encryptEntryField(
            entryId,
            'summary',
            aiResult.summary,
          ),
          aiStatus: 'done',
          updatedAt: new Date(),
        })
        .where(activeEntries(eq(entries.id, entryId)));
      // Respects tags_locked_at: hand-picked tags are never overwritten,
      // while title and summary still refresh.
      await syncEntryTags(database, entryId, aiResult.tags);
    } catch (error) {
      console.error(`AI processing failed for entry ${entryId}:`, error);
      await database
        .update(entries)
        .set({ aiStatus: 'failed', updatedAt: new Date() })
        .where(activeEntries(eq(entries.id, entryId)));
    }
  };
}

export async function processAIEntry(
  entryId: string,
  content: string,
  existingTags?: string[],
) {
  const processor = createAIProcessor({ db, client: createOpenAIClient() });
  return processor(entryId, content, existingTags);
}

export async function processAIEntries(
  items: Array<{ id: string; content: string }>,
) {
  if (items.length === 0) return;
  const client = createOpenAIClient();
  const processor = createAIProcessor({ db, client });
  const tags = await getExistingTags(db);
  await mapWithConcurrency(items, ENTRY_CONCURRENCY, (item) =>
    processor(item.id, item.content, tags),
  );
}
