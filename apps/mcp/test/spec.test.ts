import { describe, expect, it } from "vitest";
import {
  loadCachedSpec,
  MAX_TOOL_NAME,
  type OpenApiDoc,
  resolveSchema,
  snakeCase,
  toolNameFor,
  toolsFromSpec,
} from "../src/spec.ts";

const doc: OpenApiDoc = {
  paths: {
    "/api/brands/{brandId}/products/{productId}": {
      get: {
        summary: "Get one product",
        parameters: [
          { name: "brandId", in: "path", required: true, schema: { type: "string" } },
          { name: "productId", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", required: false, schema: { type: "boolean" } },
        ],
      },
      patch: {
        operationId: "editBrandProduct",
        summary: "Edit a product",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } },
        },
      },
      delete: { summary: "Delete a product" },
    },
    "/api/contents/repurpose": { post: { summary: "Bulk" } },
    "/api/contents/{id}/repurpose": { post: { summary: "One" } },
    "/api/worker/runs/{runId}/start": { post: { summary: "worker only" } },
    "/api/jobs/stream": { get: { summary: "WebSocket" } },
    "/api/pairing/claim": { post: { summary: "device token" } },
    "/api/assets": {
      post: {
        summary: "Upload",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                  brandId: { type: "string" },
                },
                required: ["file", "brandId"],
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { $ref: "#/components/schemas/Tag" } },
          parent: { $ref: "#/components/schemas/Product" },
        },
      },
      Tag: { type: "object", properties: { label: { type: "string" } }, example: { label: "x" } },
    },
  },
};

describe("OpenAPI → tools", () => {
  const tools = toolsFromSpec(doc);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("names tools in snake_case from operationId or method + path", () => {
    expect(snakeCase("editBrandProduct")).toBe("edit_brand_product");
    expect(toolNameFor("GET", "/api/brands/{id}")).toBe("get_brands_by_id");
    expect(toolNameFor("POST", "/api/contents/{id}/versions/{version}/restore")).toBe(
      "post_contents_versions_restore",
    );
    expect(toolNameFor("GET", "/api/brands/{brandId}/mention-candidates")).toBe(
      "get_brands_mention_candidates",
    );
    expect([...byName.keys()].sort()).toEqual(
      [
        "delete_brands_products_by_product_id",
        "edit_brand_product",
        "get_brands_products_by_product_id",
        "post_assets",
        "post_contents_by_id_repurpose",
        "post_contents_repurpose",
      ].sort(),
    );
  });

  it("leaves out worker-only, device-only and WebSocket operations", () => {
    for (const t of tools) {
      expect(t.path.startsWith("/api/worker/")).toBe(false);
      expect(t.path).not.toBe("/api/pairing/claim");
      expect(t.path.endsWith("/stream")).toBe(false);
    }
  });

  it("puts path and query parameters at the top and the JSON body under `body`", () => {
    const get = byName.get("get_brands_products_by_product_id");
    expect(get?.pathParams).toEqual(["brandId", "productId"]);
    expect(get?.queryParams).toEqual(["expand"]);
    expect(get?.inputSchema.required).toEqual(["brandId", "productId"]);
    expect(get?.inputSchema.properties).toMatchObject({
      brandId: { type: "string" },
      expand: { type: "boolean" },
    });

    const patch = byName.get("edit_brand_product");
    expect(patch?.pathParams).toEqual(["brandId", "productId"]); // undeclared template params
    expect(patch?.body).toBe("json");
    expect(patch?.inputSchema.required).toContain("body");
  });

  it("resolves $refs inline, cuts cycles and drops examples", () => {
    const body = byName.get("edit_brand_product")?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const product = body.body as { properties: Record<string, Record<string, unknown>> };
    expect(product.properties.name).toEqual({ type: "string" });
    expect(product.properties.tags).toEqual({
      type: "array",
      items: { type: "object", properties: { label: { type: "string" } } },
    });
    expect(String(product.properties.parent?.description)).toContain("Product");
    expect(JSON.stringify(body)).not.toContain("$ref");
    expect(resolveSchema({ $ref: "#/components/schemas/Missing" }, doc)).toHaveProperty(
      "description",
    );
  });

  it("turns multipart file fields into `<field>_path`", () => {
    const upload = byName.get("post_assets");
    expect(upload?.body).toBe("multipart");
    expect(upload?.fileFields).toEqual(["file"]);
    expect(upload?.inputSchema.properties).toMatchObject({
      body: { properties: { file_path: { type: "string" } }, required: ["file_path", "brandId"] },
    });
  });

  it("marks dangerous operations and asks for confirm", () => {
    const del = byName.get("delete_brands_products_by_product_id");
    expect(del?.dangerous).toBe(true);
    expect(del?.inputSchema.properties).toHaveProperty("confirm");
    expect(del?.description).toContain("confirm: true");
    expect(byName.get("get_brands_products_by_product_id")?.dangerous).toBe(false);
  });
});

describe("the committed openapi.json", () => {
  const tools = toolsFromSpec(loadCachedSpec());

  it("gives one valid tool per owner operation", () => {
    expect(tools.length).toBeGreaterThan(150);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
      expect(t.inputSchema.type).toBe("object");
      expect(JSON.stringify(t.inputSchema)).not.toContain('"$ref"');
      expect(JSON.stringify(t.inputSchema).length).toBeLessThan(20_000);
      if (t.dangerous) expect(t.inputSchema.properties).toHaveProperty("confirm");
    }
  });

  it("covers the main areas and classifies the risky ones", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const name of [
      "get_brands",
      "get_brands_kit",
      "post_conversations_messages",
      "get_jobs_by_id",
      "post_assets",
      "get_assets_content",
      "get_ai_spend",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    const dangerous = new Set(tools.filter((t) => t.dangerous).map((t) => t.name));
    for (const name of [
      "post_schedules_publish_now",
      "post_social_accounts_disconnect",
      "delete_assets_by_id",
      "put_ai_budget",
      "put_ai_keys_by_provider",
      "post_devices_revoke",
      "post_pairing_codes",
      "post_plans_generate",
      "post_approvals_regenerate",
      "post_jobs",
    ]) {
      expect(dangerous.has(name), name).toBe(true);
    }
    expect(dangerous.has("get_brands")).toBe(false);
    expect(dangerous.has("post_conversations_messages")).toBe(false);
  });
});
