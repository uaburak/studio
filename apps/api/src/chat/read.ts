import {
  ACTIVE_RUN_STATUSES,
  type Asset,
  CONVERSATION_SNAPSHOT_MESSAGES,
  type Conversation,
  type ConversationEvent,
  type Message,
  type Plan,
  TURN_CONTEXT_MESSAGES,
  type TurnContext,
  type TurnMessageResult,
} from "@studio/contract";
import { and, asc, count, desc, eq, gt, inArray, ne, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type AgentRunRow,
  type AliasRecord,
  type ConversationRow,
  type PlanRow,
  toAgentRun,
  toAsset,
  toBrand,
  toBrandProfile,
  toConversation,
  toConversationAlias,
  toMessage,
  toPlan,
  toPlanItem,
  toTurnAlias,
} from "../db/mappers.ts";
import {
  agentRuns,
  assets,
  brandProfiles,
  brands,
  contentPlans,
  conversationAliases,
  conversationAliasNames,
  conversationEvents,
  conversations,
  jobs,
  messages,
  planItems,
} from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";

/*
 * Read helpers shared by the API routes (plain reads) and the Hub (snapshots,
 * turn context, building stream payloads after a change).
 */

export async function requireConversation(db: Db, id: string): Promise<ConversationRow> {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!row) throw notFound("conversation", id);
  return row;
}

export async function activeRunOf(
  db: Db,
  conversationId: string,
): Promise<AgentRunRow | undefined> {
  return db.query.agentRuns.findFirst({
    where: and(
      eq(agentRuns.conversationId, conversationId),
      inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });
}

export async function conversationView(db: Db, row: ConversationRow): Promise<Conversation> {
  const active = await activeRunOf(db, row.id);
  return toConversation(row, active?.id ?? null);
}

export async function requireRun(db: Db, id: string): Promise<AgentRunRow> {
  const row = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, id) });
  if (!row) throw notFound("agent run", id);
  return row;
}

export async function assistantMessageOf(db: Db, runId: string) {
  return db.query.messages.findFirst({
    where: and(eq(messages.runId, runId), eq(messages.role, "assistant")),
  });
}

/** Newest `limit` messages, returned oldest first, plus whether older ones exist. */
export async function latestMessages(
  db: Db,
  conversationId: string,
  limit: number,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
}

/** Plans with their items; each item's generation status is read live from `jobs`. */
export async function plansWithItems(db: Db, rows: PlanRow[]): Promise<Plan[]> {
  if (rows.length === 0) return [];
  const items = await db
    .select({ item: planItems, job: { id: jobs.id, status: jobs.status, error: jobs.error } })
    .from(planItems)
    .leftJoin(jobs, eq(planItems.generationJobId, jobs.id))
    .where(
      inArray(
        planItems.planId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(planItems.position));
  return rows.map((row) =>
    toPlan(
      row,
      items.filter((x) => x.item.planId === row.id).map((x) => toPlanItem(x.item, x.job)),
    ),
  );
}

export async function loadPlan(db: Db, id: string): Promise<Plan> {
  const row = await db.query.contentPlans.findFirst({ where: eq(contentPlans.id, id) });
  if (!row) throw notFound("plan", id);
  const [plan] = await plansWithItems(db, [row]);
  if (!plan) throw notFound("plan", id);
  return plan;
}

/** Latest plan of the conversation that is still relevant (not rejected / superseded). */
export async function openPlanOf(db: Db, conversationId: string): Promise<Plan | null> {
  const row = await db.query.contentPlans.findFirst({
    where: and(
      eq(contentPlans.conversationId, conversationId),
      notInArray(contentPlans.status, ["rejected", "superseded"]),
    ),
    orderBy: desc(contentPlans.id),
  });
  if (!row) return null;
  const [plan] = await plansWithItems(db, [row]);
  return plan ?? null;
}

/** Every alias of the conversation with its asset and names, oldest first. */
export async function loadAliases(db: Db, conversationId: string): Promise<AliasRecord[]> {
  const [rows, names] = await Promise.all([
    db
      .select({ row: conversationAliases, asset: assets })
      .from(conversationAliases)
      .innerJoin(assets, eq(conversationAliases.assetId, assets.id))
      .where(eq(conversationAliases.conversationId, conversationId))
      .orderBy(asc(conversationAliases.createdAt), asc(conversationAliases.id)),
    db
      .select()
      .from(conversationAliasNames)
      .where(eq(conversationAliasNames.conversationId, conversationId))
      .orderBy(asc(conversationAliasNames.createdAt)),
  ]);
  return rows.map(({ row, asset }) => ({
    row,
    asset,
    names: names.filter((n) => n.aliasId === row.id).map((n) => n.name),
  }));
}

/** Assets referenced by attachment parts. */
async function attachedAssets(db: Db, list: Message[]): Promise<Asset[]> {
  const ids = new Set<string>();
  for (const m of list) {
    for (const p of m.parts) if (p.type === "attachment") ids.add(p.assetId);
  }
  const all = [...ids];
  const out: Asset[] = [];
  // D1 binds at most 100 parameters per statement.
  for (let i = 0; i < all.length; i += 90) {
    const rows = await db
      .select()
      .from(assets)
      .where(inArray(assets.id, all.slice(i, i + 90)));
    out.push(...rows.map(toAsset));
  }
  return out;
}

export async function turnContext(db: Db, runId: string): Promise<TurnContext> {
  const run = await requireRun(db, runId);
  const conv = await requireConversation(db, run.conversationId);
  const [{ messages: list, hasMore }, brand, profile, openPlan, assistant, total] =
    await Promise.all([
      latestMessages(db, conv.id, TURN_CONTEXT_MESSAGES),
      conv.brandId ? db.query.brands.findFirst({ where: eq(brands.id, conv.brandId) }) : undefined,
      conv.brandId
        ? db.query.brandProfiles.findFirst({
            where: and(eq(brandProfiles.brandId, conv.brandId), eq(brandProfiles.isCurrent, true)),
          })
        : undefined,
      openPlanOf(db, conv.id),
      assistantMessageOf(db, run.id),
      messageCountOf(db, conv.id),
    ]);
  return {
    run: toAgentRun(run),
    conversation: await conversationView(db, conv),
    brand: brand ? toBrand(brand) : null,
    brandProfile: profile ? toBrandProfile(profile) : null,
    messages: list,
    messagesTruncated: hasMore,
    assets: await attachedAssets(db, list),
    openPlan,
    assistantMessage: assistant ? toMessage(assistant) : null,
    aliases: (await loadAliases(db, conv.id)).map(toTurnAlias),
    messageCount: total,
  };
}

/** Messages in a conversation (all of them). */
export async function messageCountOf(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.n ?? 0;
}

/** The run and its assistant message (the worker polls it while a question or consent waits). */
export async function turnMessage(db: Db, runId: string): Promise<TurnMessageResult> {
  const run = await requireRun(db, runId);
  const message = await assistantMessageOf(db, runId);
  return { run: toAgentRun(run), message: message ? toMessage(message) : null };
}

/** State for `conversation.snapshot` (presence is added by the Hub). */
export async function conversationSnapshot(db: Db, conversationId: string) {
  const conv = await requireConversation(db, conversationId);
  const [{ messages: list, hasMore }, active, planRows, aliases] = await Promise.all([
    latestMessages(db, conversationId, CONVERSATION_SNAPSHOT_MESSAGES),
    activeRunOf(db, conversationId),
    db
      .select()
      .from(contentPlans)
      .where(
        and(eq(contentPlans.conversationId, conversationId), ne(contentPlans.status, "superseded")),
      )
      .orderBy(desc(contentPlans.id))
      .limit(20),
    loadAliases(db, conversationId),
  ]);
  return {
    seq: conv.lastSeq,
    conversation: toConversation(conv, active?.id ?? null),
    messages: list,
    hasMoreMessages: hasMore,
    activeRun: active ? toAgentRun(active) : null,
    plans: await plansWithItems(db, planRows),
    aliases: aliases.map(toConversationAlias),
  };
}

/** Stored events with seq > `after`, in order, as stream frames. */
export async function eventsAfter(
  db: Db,
  conversationId: string,
  after: number,
  limit: number,
): Promise<ConversationEvent[]> {
  const rows = await db
    .select()
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, conversationId), gt(conversationEvents.seq, after)),
    )
    .orderBy(asc(conversationEvents.seq))
    .limit(limit);
  return rows.map((r) => ({ ...r.data, seq: r.seq }) as ConversationEvent);
}
