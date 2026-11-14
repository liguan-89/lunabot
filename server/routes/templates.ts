// The local template library: saved package documents under DATA_DIR/templates. Installing a
// template is the existing import route — the client fetches the document here and posts it there.
import { deleteTemplate, listTemplates, readTemplate, saveTemplate } from "../templates.ts";
import { PackageFormatError } from "../bot-package.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TemplateRouteDeps {
  templatesDir(): string;
}

export function createTemplateRoutes(deps: TemplateRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/templates")) return PASS;
    const dir = deps.templatesDir();

    if (method === "GET" && path === "/api/templates") {
      return json(res, 200, { templates: listTemplates(dir) });
    }

    if (method === "POST" && path === "/api/templates") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !("document" in body)) {
        return json(res, 400, { error: "A package document is required." });
      }
      try {
        const name = typeof (body as { name?: unknown }).name === "string" ? (body as { name: string }).name : undefined;
        const entry = saveTemplate(dir, (body as { document: unknown }).document, name);
        return json(res, 201, { template: entry });
      } catch (error) {
        if (error instanceof PackageFormatError) return json(res, 400, { error: error.message });
        return json(res, 400, { error: error instanceof Error ? error.message : "The template could not be saved." });
      }
    }

    const m = path.match(/^\/api\/templates\/([a-z0-9][a-z0-9-]*)$/);
    if (m && method === "GET") {
      const document = readTemplate(dir, m[1]);
      return document ? json(res, 200, { document }) : json(res, 404, { error: "That template does not exist." });
    }
    if (m && method === "DELETE") {
      return deleteTemplate(dir, m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "That template does not exist." });
    }

    return PASS;
  };
}
