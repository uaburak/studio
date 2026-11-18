/**
 * LinkedIn through the cloud scheduler, end to end against the fakes: order -> media upload
 * (R2) -> alarm -> LinkedIn image/document/text posts. The media goes from storage straight
 * to LinkedIn's upload URL (the scheduler never downloads its own public URL), commentary is
 * sent in little text format, and a crash or a lost answer never posts twice.
 */

import type { CloudOrder, CloudOrderCreate } from "@studio/contract";
import { toLittleText } from "@studio/publishers";
import { describe, expect, it } from "vitest";
import {
  api,
  fakeJpeg,
  type Harness,
  HOUR,
  mediaDecl,
  runUntilIdle,
  setup,
  T0,
  upload,
} from "./helpers.ts";

const AUTHOR = "urn:li:person:burak123";
const LI_TOKEN = `AQV${"L".repeat(40)}`;
const CAPTION = "Hasat (2026) başladı! @mtm #tarım";

const li = (kind: CloudOrderCreate["targets"][number]["kind"], id = "li-target") => ({
  id,
  kind,
  accountExternalId: AUTHOR,
  accessToken: LI_TOKEN,
});

async function liOrder(
  orderId: string,
  files: { id: string; bytes: Uint8Array; mimeType?: string; kind?: "image" | "document" }[],
  kind: CloudOrderCreate["targets"][number]["kind"],
) {
  const body: CloudOrderCreate = {
    contentId: "content-li",
    versionId: "version-li",
    contentHash: "b".repeat(64),
    scheduledAt: new Date(T0 + HOUR).toISOString(),
    caption: CAPTION,
    title: "Hasat raporu",
    media: await Promise.all(
      files.map((f) =>
        mediaDecl(f, {
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.kind ? { kind: f.kind } : {}),
          ...(f.kind === "document" ? { width: undefined, height: undefined } : {}),
        }),
      ),
    ),
    targets: [li(kind)],
  };
  const created = await api<CloudOrder>("PUT", `/v1/orders/${orderId}`, body);
  expect(created.status, created.text).toBe(201);
  for (const f of files) {
    const res = await upload(orderId, f, f.mimeType ?? "image/jpeg");
    expect(res.status, res.text).toBe(200);
  }
}

async function run(h: Harness, orderId: string) {
  h.clock.t = T0 + HOUR;
  const crashes = await runUntilIdle(h);
  const order = (await api<CloudOrder>("GET", `/v1/orders/${orderId}`)).body;
  return { order, crashes };
}

describe("cloud scheduler: LinkedIn end to end", () => {
  it("publishes an image post with the bytes from storage and escaped commentary", async () => {
    const h = await setup();
    const image = { id: "slide-1.jpg", bytes: fakeJpeg(7) };
    await liOrder("li-1", [image], "linkedin.image");
    const { order } = await run(h, "li-1");

    expect(order.status).toBe("published");
    const [post] = h.linkedin.posts;
    expect(h.linkedin.posts).toHaveLength(1);
    expect(order.targets[0]).toMatchObject({
      status: "published",
      externalId: post?.urn,
      permalink: `https://www.linkedin.com/feed/update/${post?.urn}/`,
    });
    expect(post?.body).toMatchObject({
      author: AUTHOR,
      commentary: toLittleText(CAPTION),
      content: { media: { id: "urn:li:image:img-1" } },
    });
    expect(h.linkedin.uploadedBytes.get("/dms-uploads/image-1")).toEqual(image.bytes);
    // Nothing asked this Worker's public media URL for the file.
    expect(h.linkedin.calls.some((c) => c.url.includes("publisher.test"))).toBe(false);
    expect(h.fake.calls.some((c) => c.host === "publisher.test")).toBe(false);
    expect(h.linkedin.calls[0]?.headers.authorization).toBe(`Bearer ${LI_TOKEN}`);
  });

  it("publishes a PDF document post from storage", async () => {
    const h = await setup();
    const pdf = {
      id: "carousel.pdf",
      bytes: new TextEncoder().encode(`%PDF-1.7 ${"x".repeat(400)}`),
      mimeType: "application/pdf",
      kind: "document" as const,
    };
    await liOrder("li-2", [pdf], "linkedin.document");
    const { order } = await run(h, "li-2");
    expect(order.status).toBe("published");
    expect(h.linkedin.uploadedBytes.get("/dms-uploads/doc-1")).toEqual(pdf.bytes);
    expect(h.linkedin.posts[0]?.body).toMatchObject({
      content: { media: { id: "urn:li:document:doc-1", title: "Hasat raporu" } },
    });
  });

  it("publishes once even when the post call's answer is lost", async () => {
    const h = await setup();
    h.linkedin.loseNextPostResponse("504");
    await liOrder("li-3", [], "linkedin.text");
    const { order } = await run(h, "li-3");
    expect(order.status).toBe("published");
    expect(h.linkedin.posts).toHaveLength(1);
    expect(order.targets[0]?.externalId).toBe(h.linkedin.posts[0]?.urn);
  });

  it.each(["linkedin.text", "linkedin.image"] as const)(
    "%s: a crash after any step still publishes exactly once",
    async (kind) => {
      const files = kind === "linkedin.image" ? [{ id: "slide-1.jpg", bytes: fakeJpeg(3) }] : [];
      const baseline = await setup();
      await liOrder("li-crash", files, kind);
      await run(baseline, "li-crash");
      const total = baseline.steps;
      expect(total).toBeGreaterThan(0);

      for (let crashAt = 0; crashAt < total; crashAt++) {
        const h = await setup();
        await liOrder("li-crash", files, kind);
        h.hooks.beforePersist = () => {
          if (h.steps - 1 === crashAt) throw new Error("simulated crash");
        };
        const { order, crashes } = await run(h, "li-crash");
        const label = `${kind} crash@${crashAt}`;
        expect(crashes, label).toBe(1);
        expect(order.status, label).toBe("published");
        expect(h.linkedin.posts, label).toHaveLength(1);
        expect(order.targets[0]?.externalId, label).toBe(h.linkedin.posts[0]?.urn);
      }
    },
  );
});
