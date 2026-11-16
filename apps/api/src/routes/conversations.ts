import { createRoute, z } from "@hono/zod-openapi";
import {
  ACTIVE_RUN_STATUSES,
  AgentRunList,
  AgentRunListQuery,
  Conversation,
  ConversationCreate,
  ConversationList,
  ConversationListQuery,
  ConversationStreamQuery,
  ConversationUpdate,
  EntityId,
  MessageList,
  MessageListQuery,
  QuestionAnswerCreate,
  QuestionAnswerResult,
  UserMessageCreate,
  UserMessageResult,
} from "@studio/contract";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { runChat } from "../chat/command.ts";
import { conversationView, requireConversation } from "../chat/read.ts";
import { createDb } from "../db/client.ts";
import { toAgentRun, toConversation, toMessage } from "../db/mappers.ts";
import { agentRuns, conversations, messages } from "../db/schema.ts";
import { badRequest, conflict, zodIssues } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { decodeTimeCursor, encodeTimeCursor, toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { hubStub } from "./jobs.ts";

const tags = ["Conversations"];
const MessageParams = z.object({ id: EntityId, messageId: EntityId });

export const conversationRoutes = createRouter();

// --- GET /api/conversations/{id}/stream (WebSocket) ----------------------------------
// Documented by hand: a WebSocket upgrade has no JSON response to validate.

conversationRoutes.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/conversations/{id}/stream",
  tags,
  summary: "Follow a conversation live (WebSocket)",
  description:
    "WebSocket upgrade. Without `after` the server sends `conversation.snapshot`; with `after` " +
    "(the last seq the client applied) it replays the stored events after it, then " +
    "`conversation.resumed` (or a snapshot when `after` is too far behind). Live events follow, " +
    "each with a gap-free `seq`. Schema: `ConversationStreamMessage` in @studio/contract. " +
    "Clients may send `ping`.",
  request: { params: IdParams, query: ConversationStreamQuery },
  responses: {
    101: { description: "Switching protocols." },
    400: errors[400],
    404: errors[404],
    426: { description: "Not a WebSocket upgrade request." },
  },
});

conversationRoutes.get("/api/conversations/:id/stream", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const query = ConversationStreamQuery.safeParse(c.req.query());
  if (!query.success) throw badRequest("invalid request query", zodIssues(query.error));
  const id = c.req.param("id");
  await requireConversation(createDb(c.env.DB), id);
  const target = new URL("https://hub.internal/conversations");
  target.searchParams.set("conversationId", id);
  if (query.data.after !== undefined) target.searchParams.set("after", String(query.data.after));
  return hubStub(c.env).fetch(target.toString(), { headers: c.req.raw.headers });
});

conversationRoutes
  .openapi(
    createRoute({
      method: "get",
      path: "/api/conversations",
      tags,
      summary: "List conversations (most recently active first)",
      request: { query: ConversationListQuery },
      responses: { 200: json(ConversationList, "A page of conversations."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(conversations.brandId, brandId));
      if (status) where.push(eq(conversations.status, status));
      if (cursor) {
        const at = decodeTimeCursor(cursor);
        if (!at) throw badRequest("invalid cursor", [{ path: "cursor", message: "malformed" }]);
        const when = new Date(at.ms);
        const older = or(
          lt(conversations.lastActivityAt, when),
          and(eq(conversations.lastActivityAt, when), lt(conversations.id, at.id)),
        );
        if (older) where.push(older);
      }
      const rows = await createDb(c.env.DB)
        .select({ row: conversations, activeRunId: agentRuns.id })
        .from(conversations)
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.conversationId, conversations.id),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .where(and(...where))
        .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
        .limit(limit + 1);
      return c.json(
        toPage(
          rows,
          limit,
          (r) => toConversation(r.row, r.activeRunId),
          (r) => encodeTimeCursor(r.row.lastActivityAt.getTime(), r.row.id),
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/conversations",
      tags,
      summary: "Start a conversation (brand optional)",
      request: { body: jsonBody(ConversationCreate) },
      responses: {
        201: json(Conversation, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (input.brandId) {
        const brand = await requireBrand(db, input.brandId);
        if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);
      }
      const now = new Date();
      const [row] = await db
        .insert(conversations)
        .values({
          id: newId(),
          brandId: input.brandId ?? null,
          title: input.title,
          status: "active",
          lastSeq: 0,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toConversation(row, null), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/conversations/{id}",
      tags,
      summary: "Get a conversation",
      request: { params: IdParams },
      responses: { 200: json(Conversation, "The conversation."), 404: errors[404] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireConversation(db, c.req.valid("param").id);
      return c.json(await conversationView(db, row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/conversations/{id}",
      tags,
      summary: "Rename, archive / unarchive, or set the brand once",
      description:
        "`brandId` is accepted only while the conversation has no brand (409 otherwise). " +
        "An archived conversation accepts no new messages until it is unarchived.",
      request: { params: IdParams, body: jsonBody(ConversationUpdate) },
      responses: {
        200: json(Conversation, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await runChat(c.env, {
        kind: "updateConversation",
        id: c.req.valid("param").id,
        input: c.req.valid("json"),
      });
      return c.json(Conversation.parse(result), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/conversations/{id}/messages",
      tags,
      summary: "List messages (newest first; page backwards with cursor)",
      request: { params: IdParams, query: MessageListQuery },
      responses: {
        200: json(MessageList, "A page of messages."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireConversation(db, id);
      const where: SQL[] = [eq(messages.conversationId, id)];
      if (cursor) where.push(lt(messages.id, cursor));
      const rows = await db
        .select()
        .from(messages)
        .where(and(...where))
        .orderBy(desc(messages.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toMessage, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/conversations/{id}/messages",
      tags,
      summary: "Send a user message (starts an agent run)",
      description:
        "Stores the message, creates an agent run and a `chat.turn` job (dispatched to the Mac " +
        "worker now or when it connects). 409 `conflict` while another run of the conversation " +
        "is queued or running, or when the conversation is archived. Attachments must be " +
        "existing assets of the conversation's brand. With a repeated `clientMessageId` the " +
        "original message and run come back (200, `replayed: true`).",
      request: { params: IdParams, body: jsonBody(UserMessageCreate) },
      responses: {
        200: json(UserMessageResult, "Replayed (same clientMessageId)."),
        201: json(UserMessageResult, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = UserMessageResult.parse(
        await runChat(c.env, {
          kind: "sendUserMessage",
          conversationId: c.req.valid("param").id,
          input: c.req.valid("json"),
        }),
      );
      return result.replayed ? c.json(result, 200) : c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/conversations/{id}/messages/{messageId}/answer",
      tags,
      summary: "Answer a question part of an assistant message",
      description:
        "Records the answer on the question part (final; repeating the same answer is a no-op, a " +
        "different one is 409). When no run is active, the answer starts a new agent run.",
      request: { params: MessageParams, body: jsonBody(QuestionAnswerCreate) },
      responses: {
        200: json(QuestionAnswerResult, "Answered."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id, messageId } = c.req.valid("param");
      const result = await runChat(c.env, {
        kind: "answerQuestion",
        conversationId: id,
        messageId,
        input: c.req.valid("json"),
      });
      return c.json(QuestionAnswerResult.parse(result), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/conversations/{id}/runs",
      tags,
      summary: "List agent runs of a conversation (newest first)",
      request: { params: IdParams, query: AgentRunListQuery },
      responses: {
        200: json(AgentRunList, "A page of runs."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireConversation(db, id);
      const where: SQL[] = [eq(agentRuns.conversationId, id)];
      if (cursor) where.push(lt(agentRuns.id, cursor));
      const rows = await db
        .select()
        .from(agentRuns)
        .where(and(...where))
        .orderBy(desc(agentRuns.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toAgentRun, (r) => r.id),
        200,
      );
    },
  );
